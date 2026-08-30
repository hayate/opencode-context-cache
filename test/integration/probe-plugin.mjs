import { appendFileSync } from "fs";

const OUT = process.env.CONTEXT_CACHE_PROBE_OUT;

function record(entry) {
  if (OUT) appendFileSync(OUT, JSON.stringify(entry) + "\n", "utf8");
}

export const ProbePlugin = async (input) => {
  record({
    kind: "factory",
    directory: input?.directory,
    worktree: input?.worktree,
    hasWorktree: input ? "worktree" in input : false,
    vcs: input?.project?.vcs ?? null,
    cwd: process.cwd(),
  });

  return {
    // Records the shape opencode hands chat.params. This only fires when a
    // model request actually happens, which the suite cannot force without
    // credentials, so these records are treated as optional evidence.
    "chat.params": async (hookInput, output) => {
      const options = output?.options ?? {};
      record({
        kind: "chat.params",
        hasSessionID: typeof hookInput?.sessionID === "string",
        seededWithSessionID: Object.values(options).includes(hookInput?.sessionID),
        optionKeys: Object.keys(options),
        providerID: hookInput?.model?.providerID ?? null,
      });
    },
  };
};

export default ProbePlugin;
