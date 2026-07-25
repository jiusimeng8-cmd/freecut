import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { MediaTranscript } from "@/types/storage";
import type { TimelineItem, TimelineTrack, VideoItem } from "@/types/timeline";

const getTranscriptMock = vi.fn();
const useTimelineStoreGetStateMock = vi.fn();
const useProjectStoreGetStateMock = vi.fn();
const useSelectionStoreGetStateMock = vi.fn();
const usePlaybackStoreGetStateMock = vi.fn();
const removeTimelineItemsExactMock = vi.fn();
const selectItemsMock = vi.fn();

vi.mock("@/infrastructure/storage", () => ({
  deleteTranscript: vi.fn(),
  getTranscript: getTranscriptMock,
  getTranscriptMediaIds: vi.fn(),
}));

vi.mock("@/shared/state/selection", () => ({
  useSelectionStore: {
    getState: useSelectionStoreGetStateMock,
  },
}));

vi.mock("@/shared/state/playback", () => ({
  usePlaybackStore: {
    getState: usePlaybackStoreGetStateMock,
  },
}));

vi.mock("@/features/media-library/deps/projects", () => ({
  useProjectStore: {
    getState: useProjectStoreGetStateMock,
  },
}));

vi.mock("@/features/media-library/deps/timeline-stores", () => ({
  removeTimelineItemsExact: removeTimelineItemsExactMock,
  useTimelineStore: {
    getState: useTimelineStoreGetStateMock,
  },
}));

vi.mock("@/features/media-library/deps/settings-contract", () => ({
  useSettingsStore: {
    getState: () => ({
      defaultCaptionStylePresetId: "netflix",
    }),
  },
}));

vi.mock("../transcription/registry", () => ({
  getMediaTranscriptionModelLabel: () => "Tiny",
}));

const { mediaTranscriptionService } =
  await import("./media-transcription-service");

function makeTrack(id: string, order: number): TimelineTrack {
  return {
    id,
    name: id,
    height: 64,
    locked: false,
    visible: true,
    muted: false,
    solo: false,
    order,
    items: [],
  };
}

function makeTextItem(
  id: string,
  trackId: string,
  from: number,
  durationInFrames: number,
): TimelineItem {
  return {
    id,
    type: "text",
    trackId,
    from,
    durationInFrames,
    label: id,
    text: id,
    color: "#fff",
  };
}

describe("mediaTranscriptionService.insertTranscriptAsCaptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSelectionStoreGetStateMock.mockReturnValue({
      selectedItemIds: [],
      selectItems: selectItemsMock,
    });
    usePlaybackStoreGetStateMock.mockReturnValue({ currentFrame: 0 });
    useProjectStoreGetStateMock.mockReturnValue({
      currentProject: {
        metadata: {
          width: 1920,
          height: 1080,
        },
      },
    });
  });

  it("creates a new captions track above the clip track when no compatible track exists", async () => {
    const clip: VideoItem = {
      id: "clip-1",
      type: "video",
      trackId: "track-video",
      from: 0,
      durationInFrames: 90,
      label: "Clip",
      mediaId: "media-1",
      src: "blob:test",
      sourceStart: 0,
      sourceEnd: 90,
      sourceDuration: 90,
      sourceFps: 30,
      speed: 1,
      transcriptCaptions: {
        type: "transcript",
        mediaId: "media-1",
        enabled: true,
        updatedAt: Date.now(),
        cues: [
          {
            id: "virtual-1",
            startSeconds: 0,
            endSeconds: 2,
            text: "Hello there",
          },
        ],
      },
    };
    const initialTracks = [
      makeTrack("track-top", 0),
      makeTrack("track-video", 1),
      makeTrack("track-bottom", 2),
    ];
    const setTracks = vi.fn();
    const removeItems = vi.fn();
    const addItems = vi.fn();
    const updateItem = vi.fn();

    useTimelineStoreGetStateMock.mockReturnValue({
      fps: 30,
      tracks: initialTracks,
      items: [
        clip,
        makeTextItem("top-blocker", "track-top", 0, 90),
        makeTextItem("bottom-blocker", "track-bottom", 0, 90),
      ],
      setTracks,
      removeItems,
      addItems,
      updateItem,
    });

    const transcript: MediaTranscript = {
      id: "media-1",
      mediaId: "media-1",
      model: "whisper-tiny",
      language: "auto",
      quantization: "q8",
      text: "Hello there Second line",
      segments: [
        { text: "Hello there", start: 0, end: 2 },
        { text: "Second line", start: 2.2, end: 3 },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    getTranscriptMock.mockResolvedValue(transcript);

    const result = await mediaTranscriptionService.insertTranscriptAsCaptions(
      "media-1",
      {
        clipIds: ["clip-1"],
      },
    );

    expect(result).toEqual({
      insertedItemCount: 2,
      removedItemCount: 0,
    });
    expect(setTracks).toHaveBeenCalledTimes(1);

    const updatedTracks = setTracks.mock.calls[0]![0] as TimelineTrack[];
    const captionTrack = updatedTracks.find(
      (track) => !initialTracks.some((existing) => existing.id === track.id),
    );
    expect(captionTrack).toBeDefined();
    expect(captionTrack?.order).toBe(0.5);

    expect(addItems).toHaveBeenCalledTimes(1);
    const insertedItems = addItems.mock.calls[0]![0] as TimelineItem[];
    expect(insertedItems).toHaveLength(2);
    expect(insertedItems[0]?.trackId).toBe(captionTrack?.id);
    expect(insertedItems[0]).toMatchObject({
      type: "subtitle",
      label: "Transcript",
      source: {
        type: "transcript",
        mediaId: "media-1",
        clipId: "clip-1",
      },
      cues: [{ text: "Hello there", startSeconds: 0, endSeconds: 2 }],
    });
    expect(insertedItems[1]).toMatchObject({
      type: "subtitle",
      cues: [{ text: "Second line", startSeconds: 0 }],
    });
    if (insertedItems[1]?.type === "subtitle") {
      expect(insertedItems[1].cues[0]?.endSeconds).toBeCloseTo(0.8);
    }
    expect(
      insertedItems.every((item) => item.linkedGroupId === clip.linkedGroupId),
    ).toBe(true);
    expect(updateItem).toHaveBeenCalledWith("clip-1", {
      transcriptCaptions: undefined,
    });
    expect(removeItems).not.toHaveBeenCalled();
  });

  it("does not reuse an audio track when regenerating transcript captions", async () => {
    const clip: VideoItem = {
      id: "clip-1",
      type: "video",
      trackId: "track-video",
      from: 0,
      durationInFrames: 90,
      label: "Clip",
      mediaId: "media-1",
      src: "blob:test",
      sourceStart: 0,
      sourceEnd: 90,
      sourceDuration: 90,
      sourceFps: 30,
      speed: 1,
    };
    const initialTracks = [
      { ...makeTrack("track-audio", 0), name: "A1", kind: "audio" as const },
      { ...makeTrack("track-video", 1), name: "V1", kind: "video" as const },
    ];
    const legacyCaptionOnAudioTrack: TimelineItem = {
      id: "caption-old",
      type: "text",
      trackId: "track-audio",
      from: 0,
      durationInFrames: 30,
      label: "caption-old",
      text: "caption-old",
      mediaId: "media-1",
      color: "#fff",
      captionSource: {
        type: "transcript",
        clipId: "clip-1",
        mediaId: "media-1",
      },
    };
    const setTracks = vi.fn();
    const removeItems = vi.fn();
    const addItems = vi.fn();

    useTimelineStoreGetStateMock.mockReturnValue({
      fps: 30,
      tracks: initialTracks,
      items: [clip, legacyCaptionOnAudioTrack],
      setTracks,
      removeItems,
      addItems,
    });

    const transcript: MediaTranscript = {
      id: "media-1",
      mediaId: "media-1",
      model: "whisper-tiny",
      language: "auto",
      quantization: "q8",
      text: "Hello there",
      segments: [{ text: "Hello there", start: 0, end: 2 }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    getTranscriptMock.mockResolvedValue(transcript);

    const result = await mediaTranscriptionService.insertTranscriptAsCaptions(
      "media-1",
      {
        clipIds: ["clip-1"],
        replaceExisting: true,
      },
    );

    expect(result).toEqual({
      insertedItemCount: 1,
      removedItemCount: 1,
    });
    expect(setTracks).toHaveBeenCalledTimes(1);

    const updatedTracks = setTracks.mock.calls[0]![0] as TimelineTrack[];
    const captionTrack = updatedTracks.find(
      (track) => !initialTracks.some((existing) => existing.id === track.id),
    );
    expect(captionTrack).toBeDefined();
    expect(captionTrack?.kind).toBe("video");

    expect(addItems).toHaveBeenCalledTimes(1);
    const insertedItems = addItems.mock.calls[0]![0] as TimelineItem[];
    expect(insertedItems[0]?.trackId).toBe(captionTrack?.id);
    expect(insertedItems[0]?.trackId).not.toBe("track-audio");
    expect(insertedItems[0]?.type).toBe("subtitle");
    expect(removeTimelineItemsExactMock).toHaveBeenCalledWith(["caption-old"]);
    expect(removeItems).not.toHaveBeenCalled();
  });

  it("replaces an existing transcript subtitle segment without removing linked media", async () => {
    const clip: VideoItem = {
      id: "clip-1",
      type: "video",
      trackId: "track-video",
      from: 0,
      durationInFrames: 150,
      label: "Clip",
      mediaId: "media-1",
      src: "blob:test",
      sourceStart: 0,
      sourceEnd: 150,
      sourceDuration: 150,
      sourceFps: 30,
      speed: 1,
      linkedGroupId: "linked-av-1",
    };
    const linkedAudio: TimelineItem = {
      id: "audio-1",
      type: "audio",
      trackId: "track-audio",
      from: 0,
      durationInFrames: 150,
      label: "Audio",
      mediaId: "media-1",
      src: "blob:test",
      sourceStart: 0,
      sourceEnd: 150,
      sourceDuration: 150,
      sourceFps: 30,
      linkedGroupId: "linked-av-1",
    };
    const captionTrack = {
      ...makeTrack("track-captions", 0),
      kind: "video" as const,
    };
    const videoTrack = {
      ...makeTrack("track-video", 1),
      kind: "video" as const,
    };
    const audioTrack = {
      ...makeTrack("track-audio", 2),
      kind: "audio" as const,
    };
    const existingTranscript: TimelineItem = {
      id: "transcript-old",
      type: "subtitle",
      trackId: "track-captions",
      from: 0,
      durationInFrames: 60,
      label: "Transcript",
      mediaId: "media-1",
      source: {
        type: "transcript",
        mediaId: "media-1",
        clipId: "clip-1",
      },
      cues: [
        { id: "old-cue", startSeconds: 0, endSeconds: 2, text: "Old text" },
      ],
      color: "#fff",
      linkedGroupId: "linked-av-1",
    };
    const setTracks = vi.fn();
    const removeItems = vi.fn();
    const addItems = vi.fn();

    useTimelineStoreGetStateMock.mockReturnValue({
      fps: 30,
      tracks: [captionTrack, videoTrack, audioTrack],
      items: [clip, linkedAudio, existingTranscript],
      setTracks,
      removeItems,
      addItems,
    });

    getTranscriptMock.mockResolvedValue({
      id: "media-1",
      mediaId: "media-1",
      model: "whisper-tiny",
      language: "auto",
      quantization: "q8",
      text: "Fresh one Fresh two",
      segments: [
        { text: "Fresh one", start: 0, end: 1 },
        { text: "Fresh two", start: 1, end: 3 },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies MediaTranscript);

    const result = await mediaTranscriptionService.insertTranscriptAsCaptions(
      "media-1",
      {
        clipIds: ["clip-1"],
        replaceExisting: true,
      },
    );

    expect(result).toEqual({
      insertedItemCount: 2,
      removedItemCount: 1,
    });
    expect(setTracks).not.toHaveBeenCalled();
    expect(removeTimelineItemsExactMock).toHaveBeenCalledWith([
      "transcript-old",
    ]);
    expect(removeItems).not.toHaveBeenCalled();
    const insertedItems = addItems.mock.calls[0]![0] as TimelineItem[];
    expect(insertedItems).toHaveLength(2);
    expect(
      insertedItems.map((item) => ({
        type: item.type,
        trackId: item.trackId,
        linkedGroupId: item.linkedGroupId,
        source: item.type === "subtitle" ? item.source : undefined,
        text: item.type === "subtitle" ? item.cues[0]?.text : undefined,
      })),
    ).toEqual([
      {
        type: "subtitle",
        trackId: "track-captions",
        linkedGroupId: "linked-av-1",
        source: {
          type: "transcript",
          mediaId: "media-1",
          clipId: "clip-1",
        },
        text: "Fresh one",
      },
      {
        type: "subtitle",
        trackId: "track-captions",
        linkedGroupId: "linked-av-1",
        source: {
          type: "transcript",
          mediaId: "media-1",
          clipId: "clip-1",
        },
        text: "Fresh two",
      },
    ]);
  });
});

describe("mediaTranscriptionService.enableTranscriptCaptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePlaybackStoreGetStateMock.mockReturnValue({ currentFrame: 0 });
    useProjectStoreGetStateMock.mockReturnValue({
      currentProject: {
        metadata: {
          width: 1920,
          height: 1080,
        },
      },
    });
    useSelectionStoreGetStateMock.mockReturnValue({
      selectedItemIds: [],
      selectItems: vi.fn(),
    });
  });

  it("stores transcript captions on the source clip and removes stale generated subtitle items exactly", async () => {
    const clip: VideoItem = {
      id: "clip-1",
      type: "video",
      trackId: "track-video",
      from: 0,
      durationInFrames: 150,
      label: "Clip",
      mediaId: "media-1",
      src: "blob:test",
      sourceStart: 0,
      sourceEnd: 150,
      sourceDuration: 150,
      sourceFps: 30,
      speed: 1,
      linkedGroupId: "linked-av-1",
    };
    const linkedAudio: TimelineItem = {
      id: "audio-1",
      type: "audio",
      trackId: "track-audio",
      from: 0,
      durationInFrames: 150,
      label: "Audio",
      mediaId: "media-1",
      src: "blob:test",
      sourceStart: 0,
      sourceEnd: 150,
      sourceDuration: 150,
      sourceFps: 30,
      linkedGroupId: "linked-av-1",
    };
    const existingTranscript: TimelineItem = {
      id: "transcript-old",
      type: "subtitle",
      trackId: "track-captions",
      from: 0,
      durationInFrames: 60,
      label: "Transcript",
      mediaId: "media-1",
      source: {
        type: "transcript",
        mediaId: "media-1",
        clipId: "clip-1",
      },
      cues: [
        { id: "old-cue", startSeconds: 0, endSeconds: 2, text: "Old text" },
      ],
      color: "#fff",
      linkedGroupId: "linked-av-1",
    };
    const setTracks = vi.fn();
    const removeItems = vi.fn();
    const addItems = vi.fn();
    const updateItem = vi.fn();

    useTimelineStoreGetStateMock.mockReturnValue({
      fps: 30,
      tracks: [
        makeTrack("track-captions", 0),
        makeTrack("track-video", 1),
        makeTrack("track-audio", 2),
      ],
      items: [clip, linkedAudio, existingTranscript],
      setTracks,
      removeItems,
      addItems,
      updateItem,
    });

    getTranscriptMock.mockResolvedValue({
      id: "media-1",
      mediaId: "media-1",
      model: "whisper-tiny",
      language: "auto",
      quantization: "q8",
      text: "Fresh one Fresh two",
      segments: [
        { text: "Fresh one", start: 0, end: 1 },
        { text: "Fresh two", start: 1, end: 3 },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies MediaTranscript);

    const result = await mediaTranscriptionService.enableTranscriptCaptions(
      "media-1",
      {
        clipIds: ["clip-1"],
        replaceExisting: true,
      },
    );

    expect(result).toEqual({
      updatedClipCount: 1,
      removedItemCount: 1,
    });
    expect(setTracks).not.toHaveBeenCalled();
    expect(addItems).not.toHaveBeenCalled();
    expect(removeItems).not.toHaveBeenCalled();
    expect(removeTimelineItemsExactMock).toHaveBeenCalledWith([
      "transcript-old",
    ]);
    expect(updateItem).toHaveBeenCalledWith(
      "clip-1",
      expect.objectContaining({
        transcriptCaptions: expect.objectContaining({
          type: "transcript",
          mediaId: "media-1",
          enabled: true,
          style: expect.objectContaining({
            fontFamily: expect.any(String),
            transform: expect.objectContaining({
              width: expect.any(Number),
              height: expect.any(Number),
            }),
          }),
          cues: [
            {
              id: "transcript-media-1-0",
              startSeconds: 0,
              endSeconds: 1,
              text: "Fresh one",
            },
            {
              id: "transcript-media-1-1",
              startSeconds: 1,
              endSeconds: 3,
              text: "Fresh two",
            },
          ],
        }),
      }),
    );
  });

  it("can enable transcript captions without changing selection", async () => {
    const clip: VideoItem = {
      id: "clip-1",
      type: "video",
      trackId: "track-video",
      from: 0,
      durationInFrames: 150,
      label: "Clip",
      mediaId: "media-1",
      src: "blob:test",
      sourceStart: 0,
      sourceEnd: 150,
      sourceDuration: 150,
      sourceFps: 30,
      speed: 1,
    };
    const updateItem = vi.fn();

    useTimelineStoreGetStateMock.mockReturnValue({
      fps: 30,
      tracks: [makeTrack("track-video", 0)],
      items: [clip],
      setTracks: vi.fn(),
      removeItems: vi.fn(),
      addItems: vi.fn(),
      updateItem,
    });

    getTranscriptMock.mockResolvedValue({
      id: "media-1",
      mediaId: "media-1",
      model: "whisper-tiny",
      language: "auto",
      quantization: "q8",
      text: "Fresh one",
      segments: [{ text: "Fresh one", start: 0, end: 1 }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies MediaTranscript);

    await mediaTranscriptionService.enableTranscriptCaptions("media-1", {
      clipIds: ["clip-1"],
      selectUpdatedClips: false,
    });

    expect(updateItem).toHaveBeenCalledWith(
      "clip-1",
      expect.objectContaining({
        transcriptCaptions: expect.objectContaining({
          enabled: true,
        }),
      }),
    );
    expect(selectItemsMock).not.toHaveBeenCalled();
  });
});
