/**
 * CDK Custom Resource handler — keeps Bedrock Agent aliases tracking the
 * latest DRAFT.
 *
 * Why this exists: Bedrock has no built-in "alias tracks latest" mode.
 * `autoPrepare: true` on the CfnAgent updates DRAFT, but the production
 * alias keeps serving whatever version it was first pinned to (usually v1).
 * Every `cdk deploy` would silently no-op the runtime without this.
 *
 * Mechanics:
 *   1. PrepareAgent — idempotent; ensures DRAFT is fresh.
 *   2. CreateAgentAlias (throwaway) — this is the ONLY API that auto-creates
 *      a new numbered version from DRAFT. Side effect we want, name we don't.
 *   3. UpdateAgentAlias on the real `live` alias → point to new version.
 *   4. DeleteAgentAlias on the throwaway.
 *
 * CR contract:
 *   - Create / Update → run the full bump sequence.
 *   - Delete → no-op (we don't want to touch the alias when the CR is
 *     removed; let CDK delete the CfnAgentAlias itself).
 *
 * Properties expected (passed from CDK):
 *   - agentId: string
 *   - aliasId: string  (the production `live` alias to repoint)
 *   - aliasName: string ('live' — update-agent-alias requires the name)
 *   - deployTimestamp: string (forces CFN to re-run this CR on every deploy)
 */
import {
  BedrockAgentClient,
  PrepareAgentCommand,
  GetAgentCommand,
  CreateAgentAliasCommand,
  GetAgentAliasCommand,
  UpdateAgentAliasCommand,
  DeleteAgentAliasCommand,
  ListAgentAliasesCommand,
} from "@aws-sdk/client-bedrock-agent";

const client = new BedrockAgentClient({ region: process.env.REGION || "us-east-1" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForAgent(agentId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await client.send(new GetAgentCommand({ agentId }));
    const s = r.agent?.agentStatus;
    console.log(`[bumpAliases] agent ${agentId} status=${s}`);
    if (s === "PREPARED") return;
    if (s === "FAILED" || s === "DELETING") throw new Error(`Agent in terminal status ${s}`);
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for agent ${agentId} to PREPARE`);
}

async function waitForAlias(agentId: string, aliasId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await client.send(new GetAgentAliasCommand({ agentId, agentAliasId: aliasId }));
    const s = r.agentAlias?.agentAliasStatus;
    console.log(`[bumpAliases] alias ${aliasId} status=${s}`);
    if (s === "PREPARED") return;
    if (s === "FAILED" || s === "DELETING") throw new Error(`Alias in terminal status ${s}`);
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for alias ${aliasId} to PREPARE`);
}

/**
 * Sweep up any leftover `bump-*` aliases from prior failed runs. Idempotent:
 * succeeds even if there are none. Failures here are non-fatal.
 */
async function cleanupOrphanBumps(agentId: string): Promise<void> {
  try {
    const list = await client.send(new ListAgentAliasesCommand({ agentId, maxResults: 100 }));
    const orphans = (list.agentAliasSummaries || []).filter(
      (a) => a.agentAliasName?.startsWith("bump-") && a.agentAliasId,
    );
    for (const o of orphans) {
      console.log(`[bumpAliases] deleting orphan bump alias ${o.agentAliasId} (${o.agentAliasName})`);
      try {
        await client.send(new DeleteAgentAliasCommand({ agentId, agentAliasId: o.agentAliasId! }));
      } catch (e: any) {
        console.warn(`[bumpAliases]   delete failed (continuing):`, e?.message);
      }
    }
  } catch (e: any) {
    console.warn(`[bumpAliases] cleanupOrphanBumps failed (continuing):`, e?.message);
  }
}

async function bumpOne(agentId: string, aliasId: string, aliasName: string): Promise<string> {
  console.log(`[bumpAliases] === bumping ${agentId} (alias ${aliasId} / ${aliasName}) ===`);

  // 0. Sweep up any orphan bump-* aliases from prior failed runs so they
  //    don't accumulate and hit per-agent alias quotas.
  await cleanupOrphanBumps(agentId);

  // 1. Re-prepare DRAFT (idempotent — agent may already be PREPARED).
  try {
    await client.send(new PrepareAgentCommand({ agentId }));
  } catch (e: any) {
    // ConflictException is fine — a prepare is already in flight. Just wait.
    if (e?.name !== "ConflictException") throw e;
    console.log(`[bumpAliases] prepare already in-flight for ${agentId}, waiting...`);
  }
  await waitForAgent(agentId);

  // 2. Create a throwaway alias. Bedrock asynchronously snapshots DRAFT into
  //    a new numbered version and populates routingConfiguration[0].agentVersion
  //    as the alias transitions CREATING → PREPARED. The CreateAgentAlias
  //    response comes back IMMEDIATELY with routingConfiguration:[{}] — the
  //    version isn't assigned yet. We must wait for PREPARED and then re-fetch
  //    via GetAgentAlias to read the populated version.
  const tmpName = `bump-${Date.now()}`;
  const created = await client.send(new CreateAgentAliasCommand({
    agentId,
    agentAliasName: tmpName,
  }));
  const tmpAliasId = created.agentAlias?.agentAliasId;
  if (!tmpAliasId) {
    throw new Error(`CreateAgentAlias returned no aliasId: ${JSON.stringify(created.agentAlias)}`);
  }
  console.log(`[bumpAliases] created temp alias ${tmpAliasId}, waiting for PREPARED + version assignment...`);

  await waitForAlias(agentId, tmpAliasId);

  // Re-fetch to get the now-assigned version number.
  const fetched = await client.send(new GetAgentAliasCommand({ agentId, agentAliasId: tmpAliasId }));
  const newVersion = fetched.agentAlias?.routingConfiguration?.[0]?.agentVersion;
  if (!newVersion) {
    throw new Error(`Temp alias PREPARED but version still empty: ${JSON.stringify(fetched.agentAlias)}`);
  }
  console.log(`[bumpAliases] temp alias ${tmpAliasId} → version ${newVersion}`);

  // 3. Point the real `live` alias at the new version.
  await client.send(new UpdateAgentAliasCommand({
    agentId,
    agentAliasId: aliasId,
    agentAliasName: aliasName,
    routingConfiguration: [{ agentVersion: newVersion }],
  }));
  console.log(`[bumpAliases] live alias ${aliasId} now routes to version ${newVersion}`);

  // Wait for live alias to stabilize on the new routing.
  await waitForAlias(agentId, aliasId);

  // 4. Cleanup — delete the throwaway. Non-fatal if it fails (the next run's
  //    cleanupOrphanBumps will collect it). Better to surface bump success
  //    than fail the whole CR on a delete glitch.
  try {
    await client.send(new DeleteAgentAliasCommand({ agentId, agentAliasId: tmpAliasId }));
    console.log(`[bumpAliases] deleted temp alias ${tmpAliasId}`);
  } catch (e: any) {
    console.warn(`[bumpAliases] failed to delete temp alias ${tmpAliasId} (continuing):`, e?.message);
  }

  return newVersion;
}

export const handler = async (event: any): Promise<any> => {
  console.log(`[bumpAliases] event: ${JSON.stringify(event)}`);

  if (event.RequestType === "Delete") {
    // Do not touch the alias on stack deletion; let CDK delete the
    // CfnAgentAlias resource cleanly.
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  const props = event.ResourceProperties || {};
  const agentId: string = props.agentId;
  const aliasId: string = props.aliasId;
  const aliasName: string = props.aliasName || "live";

  if (!agentId || !aliasId) {
    throw new Error(`Missing required ResourceProperties: agentId=${agentId}, aliasId=${aliasId}`);
  }

  const newVersion = await bumpOne(agentId, aliasId, aliasName);

  return {
    PhysicalResourceId: `${agentId}-${aliasId}-bumper`,
    Data: { newVersion },
  };
};
