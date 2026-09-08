// delulu engine — public API.
//
// delulu is a handoff+resume tool. The engine's whole job is to read a session
// transcript and answer three questions for the CLI: what happened (parseSessionLog),
// which files the agent mutated (mutatedFiles), and which repo this is (repoKey).

export { parseSessionLog } from './tail';
export type { ParsedSession } from './tail';
export { mutatedFiles, isMutatingTool, isMutatingCall } from './files';
export { repoKey } from './repo-key';
