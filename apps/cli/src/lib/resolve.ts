// Issue-ref parsing lives in core so the web backend (apps/server) can
// resolve the same references the CLI accepts.
export { parseIssueRef, issueRefToWorkflowId, type IssueRef } from "@issue-pipeline/core";
