export interface NativeArtifactStagingInput {
  readonly sourceNativeRoot: string;
  readonly bundleDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export function stageNativeArtifacts(input: NativeArtifactStagingInput): void;
