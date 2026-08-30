import { appendFileSync } from "fs";

const OUT = process.env.CONTEXT_CACHE_PROBE_OUT;

export const ProbePlugin = async (input) => {
  if (OUT) {
    appendFileSync(
      OUT,
      JSON.stringify({
        directory: input?.directory,
        worktree: input?.worktree,
        hasWorktree: input ? "worktree" in input : false,
        vcs: input?.project?.vcs ?? null,
        cwd: process.cwd(),
      }) + "\n",
      "utf8",
    );
  }
  return {};
};

export default ProbePlugin;
