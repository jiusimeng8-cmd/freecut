export interface SceneCaptionData {
  caption?: string
  shotType?: string
  subjects?: string[]
  action?: string
  setting?: string
  lighting?: string
  timeOfDay?: string
  weather?: string
}

export interface MediaCaption {
  timeSec: number
  text: string
  /** Structured scene metadata preserved with existing captions. */
  sceneData?: SceneCaptionData
  /**
   * Workspace-relative path to a captured JPEG thumbnail for this scene,
   * e.g. `media/{mediaId}/cache/ai/captions-thumbs/{index}.jpg`. Absent on
   * captions generated before the Scene Browser feature landed.
   */
  thumbRelPath?: string
  /** Legacy persisted field. Scene Browser no longer reads or creates it. */
  embedding?: number[]
  /**
   * Structural dominant-color palette for the thumbnail, in CIELAB
   * with pixel-coverage weights. Powers ∆E-based color-query ranking
   * independent of CLIP — Lab distances are perceptually uniform so
   * "red" queries actually hit red scenes rather than whatever CLIP
   * happens to associate with the token.
   */
  palette?: Array<{ l: number; a: number; b: number; weight: number }>
}
