// The detector now lives in @witness/ai (packages/ai/src/manipulation.ts) so the engine's screening
// can run it; the spikes keep importing it from here.
export { TACTICS, DetectorOut, MANIPULATION_V1, MANIPULATION_V2, locate, decide, assess } from "@witness/ai";
export type { Tactic, DetectorOutput, Conversation, GroundedTactic, Intervention, Assessment } from "@witness/ai";
