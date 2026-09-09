import { readVaultState } from "@/lib/vault";
import { fresh } from "@/lib/http/respond";

// GET /api/state — the whole vault snapshot the HUD polls every 5s.
// No caching: the runner and the user's own editor both write underneath us.

// Must be a literal: Next statically analyses segment config, so it cannot
// be imported from a shared module.
export const dynamic = "force-dynamic";

export async function GET() {
  return fresh(readVaultState() as unknown as Record<string, unknown>);
}
