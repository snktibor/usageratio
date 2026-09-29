import type { DraftProblem } from "@/components/settings/draft";
import type { Translator } from "@/lib/i18n";
import { MAX_ALERT_THRESHOLDS, MAX_GROUPS } from "@/lib/settings";
import { MAX_SUB_LIMIT_MODELS, MAX_SUB_LIMIT_NAME_LENGTH } from "@/lib/sub-limits";

/**
 * The sentence a `DraftProblem` code shows, in the `Settings` translator its
 * caller already holds.
 *
 * @example
 * const t = useTranslations("Settings");
 * setProblem(problemText(t, problem));
 */
export function problemText(t: Translator<"Settings">, problem: DraftProblem): string {
  switch (problem.code) {
    case "at_least_one_visible_account":
      return t("at_least_one_visible_account");
    case "invalid_provider_limit":
      return t("invalid_provider_limit", { label: problem.label });
    case "reset_time_format_error":
      return t("reset_time_format_error");
    case "invalid_time_zone":
      return t("timezone_invalid");
    case "invalid_group_color":
      return t("invalid_group_color", { id: problem.id });
    case "missing_sublimit_name":
      return t("missing_sublimit_name", { label: problem.label, maxLength: MAX_SUB_LIMIT_NAME_LENGTH });
    case "duplicate_sublimit_name":
      return t("duplicate_sublimit_name", { label: problem.label, name: problem.name });
    case "invalid_sublimit_models":
      return t("invalid_sublimit_models", { name: problem.name, maxModels: MAX_SUB_LIMIT_MODELS });
    case "invalid_sublimit_share":
      return t("invalid_sublimit_share", { name: problem.name });
    case "invalid_sublimit_limit":
      return t("invalid_sublimit_limit", { name: problem.name });
    case "group_name_rules":
      return t("group_name_rules");
    case "group_already_exists":
      return t("group_already_exists", { id: problem.id });
    case "max_groups_reached":
      return t("max_groups_reached", { maxGroups: MAX_GROUPS });
    case "invalid_alert_webhook":
      return t("invalid_alert_webhook");
    case "invalid_alert_threshold":
      return t("alerts_threshold_invalid");
    case "max_alert_thresholds_reached":
      return t("alerts_threshold_max", { max: MAX_ALERT_THRESHOLDS });
    case "alerts_need_at_least_one_threshold":
      return t("alerts_need_at_least_one_threshold");
  }
}
