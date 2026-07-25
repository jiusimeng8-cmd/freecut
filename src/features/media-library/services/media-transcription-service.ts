import {
  deleteTranscript,
  getTranscript,
  getTranscriptMediaIds,
  saveTranscript,
} from "@/infrastructure/storage";
import { usePlaybackStore } from "@/shared/state/playback";
import { useSelectionStore } from "@/shared/state/selection";
import {
  DEFAULT_PROJECT_HEIGHT,
  DEFAULT_PROJECT_WIDTH,
} from "@/shared/projects/defaults";
import {
  getCloudMcpConfig,
  isCloudMcpConfigured,
} from "@/shared/state/cloud-mcp-config-store";
import type { MediaTranscript } from "@/types/storage";
import type {
  AudioItem,
  SubtitleSegmentItem,
  TimelineTranscriptCaptionCue,
  TimelineItem,
  TimelineTrack,
  VideoItem,
} from "@/types/timeline";
import {
  buildSubtitleSegmentForClip,
  getCaptionStyleTemplateFromPreset,
  buildCaptionTrackAbove,
  type CaptionTextItemTemplate,
  findReplaceableCaptionItemsForClip,
  findCompatibleCaptionTrackForRanges,
  isCaptionTrackCandidate,
  getCaptionTextItemTemplate,
  getCaptionRangeForClip,
} from "../utils/caption-items";
import { useProjectStore } from "@/features/media-library/deps/projects";
import {
  removeTimelineItemsExact,
  useTimelineStore,
} from "@/features/media-library/deps/timeline-stores";
import { useSettingsStore } from "@/features/media-library/deps/settings-contract";
import { importMediaLibraryService } from "./media-library-service-loader";
import { transcribeWithCloudMcp } from "./dashscope-asr-client";

type CaptionableClip = AudioItem | VideoItem;
interface InsertTranscriptAsCaptionsOptions {
  clipIds?: readonly string[];
  replaceExisting?: boolean;
  selectUpdatedClips?: boolean;
}

interface InsertTranscriptAsCaptionsResult {
  insertedItemCount: number;
  removedItemCount: number;
}

interface EnableTranscriptCaptionsResult {
  updatedClipCount: number;
  removedItemCount: number;
}

function definedCaptionStyleFields(
  template: Partial<CaptionTextItemTemplate> | undefined,
): Partial<CaptionTextItemTemplate> {
  if (!template) return {};
  const defined: Partial<CaptionTextItemTemplate> = {};
  for (const key of Object.keys(template) as Array<
    keyof CaptionTextItemTemplate
  >) {
    const value = template[key];
    if (value !== undefined) {
      (defined as Record<string, unknown>)[key] = value;
    }
  }
  return defined;
}

class MediaTranscriptionService {
  private readonly transcriptChangeListeners = new Set<
    (mediaId: string) => void
  >();

  getTranscript = getTranscript;
  getTranscriptMediaIds = getTranscriptMediaIds;

  /** Notifies subscribers when a media's stored transcript is created, replaced, or deleted. */
  onTranscriptChanged(listener: (mediaId: string) => void): () => void {
    this.transcriptChangeListeners.add(listener);
    return () => {
      this.transcriptChangeListeners.delete(listener);
    };
  }

  private emitTranscriptChanged(mediaId: string): void {
    for (const listener of this.transcriptChangeListeners) {
      listener(mediaId);
    }
  }

  async deleteTranscript(mediaId: string): Promise<void> {
    await deleteTranscript(mediaId);
    this.emitTranscriptChanged(mediaId);
  }

  async transcribeMedia(mediaId: string): Promise<MediaTranscript> {
    const config = getCloudMcpConfig();
    if (!isCloudMcpConfigured(config)) {
      throw new Error("请先配置剪好 MCP Key");
    }

    const { mediaLibraryService } = await importMediaLibraryService();
    const media = await mediaLibraryService.getMedia(mediaId);
    if (!media) throw new Error("找不到要转写的媒体");

    const blob = await mediaLibraryService.getMediaFile(media);
    if (!blob) throw new Error(`无法读取 "${media.fileName}"`);

    const file =
      blob instanceof File
        ? blob
        : new File([blob], media.fileName, {
            type: blob.type || media.mimeType || "application/octet-stream",
          });
    const result = await transcribeWithCloudMcp(file, config, media.duration);
    if (result.segments.length === 0) {
      throw new Error("剪好 MCP 未识别到可用语音");
    }

    const now = Date.now();
    const previous = await getTranscript(mediaId);
    const transcript = await saveTranscript({
      id: mediaId,
      mediaId,
      model: "fun-asr",
      quantization: "fp32",
      text: result.text,
      segments: result.segments,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
    this.emitTranscriptChanged(mediaId);
    return transcript;
  }

  async insertTranscriptAsCaptions(
    mediaId: string,
    options: InsertTranscriptAsCaptionsOptions = {},
  ): Promise<InsertTranscriptAsCaptionsResult> {
    const transcript = await getTranscript(mediaId);
    if (!transcript) {
      throw new Error("No transcript found for this media item");
    }

    const timeline = useTimelineStore.getState();
    const project = useProjectStore.getState().currentProject;
    const targetClips = this.resolveCaptionTargetClips(
      mediaId,
      options.clipIds,
    );
    if (targetClips.length === 0) {
      throw new Error(
        "Select a clip for this media, or place one on the timeline first",
      );
    }

    const canvasWidth = project?.metadata.width ?? DEFAULT_PROJECT_WIDTH;
    const canvasHeight = project?.metadata.height ?? DEFAULT_PROJECT_HEIGHT;
    const defaultCaptionTemplate = getCaptionStyleTemplateFromPreset(
      useSettingsStore.getState().defaultCaptionStylePresetId,
      canvasWidth,
      canvasHeight,
    );
    const newTracks: TimelineTrack[] = [...timeline.tracks];
    const generatedCaptionIdsToRemove = options.replaceExisting
      ? new Set(
          targetClips.flatMap((clip) =>
            findReplaceableCaptionItemsForClip(
              timeline.items,
              clip,
              "transcript",
            ).map((item) => item.id),
          ),
        )
      : new Set<string>();
    const plannedItems = timeline.items.filter(
      (item) => !generatedCaptionIdsToRemove.has(item.id),
    );
    const insertedItems: SubtitleSegmentItem[] = [];

    for (const clip of targetClips) {
      const clipRange = getCaptionRangeForClip(
        clip,
        transcript.segments,
        timeline.fps,
      );
      if (!clipRange) {
        continue;
      }

      const existingGeneratedCaptions = options.replaceExisting
        ? findReplaceableCaptionItemsForClip(timeline.items, clip, "transcript")
        : [];
      const previousVirtualStyle = clip.transcriptCaptions?.style;
      const previousVirtualStyleTemplate = previousVirtualStyle
        ? (definedCaptionStyleFields(
            previousVirtualStyle,
          ) as CaptionTextItemTemplate)
        : undefined;
      const preferredTrackId = this.resolvePreferredCaptionTrackId(
        newTracks,
        plannedItems,
        existingGeneratedCaptions,
        clipRange,
      );

      let targetTrack = preferredTrackId
        ? (newTracks.find((track) => track.id === preferredTrackId) ?? null)
        : findCompatibleCaptionTrackForRanges(newTracks, plannedItems, [
            { startFrame: clipRange.startFrame, endFrame: clipRange.endFrame },
          ]);

      if (!targetTrack) {
        const clipTrack = newTracks.find((track) => track.id === clip.trackId);
        targetTrack = clipTrack
          ? buildCaptionTrackAbove(newTracks, clipTrack.order)
          : buildCaptionTrackAbove(newTracks, 0);
        newTracks.push(targetTrack);
        newTracks.sort((a, b) => a.order - b.order);
      }

      const styleTemplate = existingGeneratedCaptions[0]
        ? getCaptionTextItemTemplate(existingGeneratedCaptions[0])
        : (previousVirtualStyleTemplate ?? defaultCaptionTemplate);
      const clipCaptionItems = transcript.segments.flatMap((segment, index) => {
        const item = buildSubtitleSegmentForClip({
          trackId: targetTrack.id,
          cues: [
            {
              id: `transcript-${clip.id}-${index}`,
              startSeconds: segment.start,
              endSeconds: segment.end,
              text: segment.text,
            },
          ],
          clip,
          timelineFps: timeline.fps,
          canvasWidth,
          canvasHeight,
          label: "Transcript",
          source: {
            type: "transcript",
            mediaId,
            clipId: clip.id,
          },
          styleTemplate,
        });

        return item ? [item] : [];
      });

      insertedItems.push(...clipCaptionItems);
      plannedItems.push(...clipCaptionItems);
    }

    if (insertedItems.length === 0 && generatedCaptionIdsToRemove.size === 0) {
      throw new Error(
        "Transcript does not overlap the selected clip source range",
      );
    }

    const tracksChanged =
      newTracks.length !== timeline.tracks.length ||
      newTracks.some((track, index) => track.id !== timeline.tracks[index]?.id);
    if (tracksChanged) {
      timeline.setTracks(newTracks);
    }

    if (generatedCaptionIdsToRemove.size > 0) {
      removeTimelineItemsExact([...generatedCaptionIdsToRemove]);
    }

    if (insertedItems.length > 0) {
      timeline.addItems(insertedItems);
      for (const clip of targetClips) {
        if (clip.transcriptCaptions) {
          timeline.updateItem(clip.id, { transcriptCaptions: undefined });
        }
      }
      useSelectionStore
        .getState()
        .selectItems(insertedItems.map((item) => item.id));
    }

    return {
      insertedItemCount: insertedItems.length,
      removedItemCount: generatedCaptionIdsToRemove.size,
    };
  }

  async enableTranscriptCaptions(
    mediaId: string,
    options: InsertTranscriptAsCaptionsOptions = {},
  ): Promise<EnableTranscriptCaptionsResult> {
    const transcript = await getTranscript(mediaId);
    if (!transcript) {
      throw new Error("No transcript found for this media item");
    }

    const timeline = useTimelineStore.getState();
    const project = useProjectStore.getState().currentProject;
    const targetClips = this.resolveCaptionTargetClips(
      mediaId,
      options.clipIds,
    );
    if (targetClips.length === 0) {
      throw new Error(
        "Select a clip for this media, or place one on the timeline first",
      );
    }

    const canvasWidth = project?.metadata.width ?? DEFAULT_PROJECT_WIDTH;
    const canvasHeight = project?.metadata.height ?? DEFAULT_PROJECT_HEIGHT;
    const defaultCaptionTemplate = getCaptionStyleTemplateFromPreset(
      useSettingsStore.getState().defaultCaptionStylePresetId,
      canvasWidth,
      canvasHeight,
    );
    const sourceCues: TimelineTranscriptCaptionCue[] = transcript.segments.map(
      (segment, index) => ({
        id: `transcript-${mediaId}-${index}`,
        startSeconds: segment.start,
        endSeconds: segment.end,
        text: segment.text,
      }),
    );
    const generatedCaptionIdsToRemove = options.replaceExisting
      ? new Set(
          targetClips.flatMap((clip) =>
            findReplaceableCaptionItemsForClip(
              timeline.items,
              clip,
              "transcript",
            ).map((item) => item.id),
          ),
        )
      : new Set<string>();

    let updatedClipCount = 0;
    for (const clip of targetClips) {
      const clipRange = getCaptionRangeForClip(
        clip,
        transcript.segments,
        timeline.fps,
      );
      if (!clipRange) continue;

      const existingGeneratedCaptions = options.replaceExisting
        ? findReplaceableCaptionItemsForClip(timeline.items, clip, "transcript")
        : [];
      const previousVirtualStyle = clip.transcriptCaptions?.style;
      const existingStyle =
        existingGeneratedCaptions[0] !== undefined
          ? getCaptionTextItemTemplate(existingGeneratedCaptions[0])
          : undefined;
      const mergedStyleTemplate = {
        ...definedCaptionStyleFields(defaultCaptionTemplate),
        ...definedCaptionStyleFields(previousVirtualStyle),
        ...definedCaptionStyleFields(existingStyle),
      } as CaptionTextItemTemplate;
      const styleTemplate =
        Object.keys(mergedStyleTemplate).length > 0
          ? mergedStyleTemplate
          : undefined;

      timeline.updateItem(clip.id, {
        transcriptCaptions: {
          type: "transcript",
          mediaId,
          enabled: true,
          updatedAt: Date.now(),
          cues: sourceCues,
          ...(styleTemplate ? { style: styleTemplate } : {}),
        },
      } as Partial<TimelineItem>);
      updatedClipCount += 1;
    }

    if (updatedClipCount === 0 && generatedCaptionIdsToRemove.size === 0) {
      throw new Error(
        "Transcript does not overlap the selected clip source range",
      );
    }

    if (generatedCaptionIdsToRemove.size > 0) {
      removeTimelineItemsExact([...generatedCaptionIdsToRemove]);
    }

    if (updatedClipCount > 0 && options.selectUpdatedClips !== false) {
      useSelectionStore
        .getState()
        .selectItems(targetClips.map((clip) => clip.id));
    }

    return {
      updatedClipCount,
      removedItemCount: generatedCaptionIdsToRemove.size,
    };
  }

  private resolveCaptionTargetClips(
    mediaId: string,
    clipIds?: readonly string[],
  ): CaptionableClip[] {
    const timeline = useTimelineStore.getState();
    const selection = useSelectionStore.getState();
    const playheadFrame = usePlaybackStore.getState().currentFrame;

    const matchingClips = timeline.items
      .filter(
        (item): item is CaptionableClip =>
          (item.type === "video" || item.type === "audio") &&
          item.mediaId === mediaId,
      )
      .sort((a, b) => a.from - b.from);

    if (matchingClips.length === 0) {
      return [];
    }

    if (clipIds && clipIds.length > 0) {
      const requestedClipIds = new Set(clipIds);
      return matchingClips.filter((clip) => requestedClipIds.has(clip.id));
    }

    const selectedClips = selection.selectedItemIds
      .map((id) => matchingClips.find((clip) => clip.id === id))
      .filter((clip): clip is CaptionableClip => clip !== undefined);

    if (selectedClips.length > 0) {
      return selectedClips;
    }

    if (matchingClips.length === 1) {
      return matchingClips;
    }

    const clipAtPlayhead = matchingClips.find(
      (clip) =>
        playheadFrame >= clip.from &&
        playheadFrame < clip.from + clip.durationInFrames,
    );
    if (clipAtPlayhead) {
      return [clipAtPlayhead];
    }

    return [];
  }

  private resolvePreferredCaptionTrackId(
    tracks: readonly TimelineTrack[],
    items: readonly TimelineItem[],
    existingCaptions: ReadonlyArray<{ trackId: string }>,
    range: { startFrame: number; endFrame: number },
  ): string | null {
    const trackIds = [...new Set(existingCaptions.map((item) => item.trackId))];
    if (trackIds.length !== 1) {
      return null;
    }

    const preferredTrack = tracks.find((track) => track.id === trackIds[0]);
    if (!preferredTrack || !isCaptionTrackCandidate(preferredTrack, items)) {
      return null;
    }

    const hasOverlap = items.some((item) => {
      if (item.trackId !== preferredTrack.id) {
        return false;
      }

      const itemEnd = item.from + item.durationInFrames;
      return item.from < range.endFrame && itemEnd > range.startFrame;
    });

    return hasOverlap ? null : preferredTrack.id;
  }
}

export const mediaTranscriptionService = new MediaTranscriptionService();
