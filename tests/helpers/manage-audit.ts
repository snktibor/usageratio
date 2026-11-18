import {
  type ManageAuditRecord,
  type ManageAuditWriter,
  parseManageAuditRecord,
  serializeManageAuditRecord,
} from "@/lib/manage-audit";
import { getRedis } from "@/lib/redis";
import { KEYS } from "./tenant";

/** A writer with fixed request fields: every call is recorded in `calls`, so a test can tell "wrote one entry" from "was never asked". */
export function stubAudit(at = 1_000): { audit: ManageAuditWriter; calls: Parameters<ManageAuditWriter>[0][] } {
  const calls: Parameters<ManageAuditWriter>[0][] = [];
  const audit: ManageAuditWriter = async (detail) => {
    calls.push(detail);
    return serializeManageAuditRecord({
      at,
      action: detail.action,
      subject: detail.subject,
      affected: detail.affected ?? null,
      trashId: detail.trashId ?? null,
      userAgent: "",
      brands: "",
      platform: "",
      ip: null,
      ipHash: null,
      ipPrefix: null,
      session: null,
      by: null,
    });
  };
  return { audit, calls };
}

/** The stored manage trail, newest first. */
export async function manageTrail(): Promise<ManageAuditRecord[]> {
  const raw = await getRedis().lrange<string>(KEYS.manageAudit, 0, -1);
  return raw.map((item) => {
    const record = parseManageAuditRecord(String(item));
    if (!record) throw new Error(`unreadable manage audit entry: ${item}`);
    return record;
  });
}
