/**
 * Display name for the human who runs this deployment. Shown in the
 * conversation drawer and in text returned to agents. Set
 * NEXT_PUBLIC_MC_OPERATOR to your own name; defaults to "Operator".
 */
export const OPERATOR: string = process.env.NEXT_PUBLIC_MC_OPERATOR?.trim() || "Operator";
