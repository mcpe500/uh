export interface RepoFile {
	path: string;
	content: string;
}

export interface ArchitecturalBrief {
	raw: string;
	targetFile?: string;
	rootCause?: string;
	criteria: string[];
}

export interface SolutionBlueprint {
	logicDesign: string;
	targetFunctions: string[];
	testPlan: string;
}

export interface TripletInput {
	originalFiles: RepoFile[];
	architecturalBrief: string;
	solutionBlueprint: string;
}

export interface CanonicalPatch {
	filePath: string;
	content: string;
}

export interface UHarnessTelemetry {
	durationMs: number;
	slmInboundTokens: number;
	cloudReasonerTokens: number;
	slmOutboundTokens: number;
	pipelineMode: "baseline" | "u-shaped";
}

export interface TurnExecutionInput {
	task: string;
	files: RepoFile[];
	callSlm?: (prompt: string) => Promise<string>;
	callCloudReasoner: (prompt: string) => Promise<string>;
}

export interface TurnExecutionResult {
	pipelineMode: "baseline" | "u-shaped";
	architecturalBrief?: string;
	solutionBlueprint?: string;
	patches: CanonicalPatch[];
	finalOutput: string;
	telemetry: UHarnessTelemetry;
}
