import type { Route } from "./http.ts";
import { operations } from "./openapi.ts";

/** Hand-written adapters that describe defaults or accept writes for absent core concepts. */
export const neutralAdapters = new Set([
  "GetConfiguration",
  "GetNamedConfiguration",
  "GetPasswordResetProviders",
  "ForgotPassword",
  "ForgotPasswordPin",
  "UpdateItemContentType",
  "GetPublicUsers",
]);

/** Counts every pinned operation once; a missing or unclassified route remains a visible gap. */
export function coverageSummary(routes: readonly Route[]) {
  const registered = new Map(
    routes.map((route) => [`${route.method} ${route.path}`, route]),
  );
  const summary = { total: operations.length, real: 0, neutral: 0, gaps: 0 };
  for (const operation of operations) {
    const behaviour = registered.get(
      `${operation.method} ${operation.path}`,
    )?.behaviour;
    if (behaviour === undefined) summary.gaps++;
    else summary[behaviour]++;
  }
  return summary;
}
