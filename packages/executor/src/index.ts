export * from "./executor.ts";
export * from "./dispatch.ts";
export { checkPayout, executePayout, payoutReceiver, sweepPayouts, type PayoutJob } from "./payout.ts";
export { consumeApproval, type ConsumedApproval } from "./approvals.ts";
export { executeAp2Capture, executeAp2Void, reconcileAp2 } from "./settlement.ts";

// The worker obtains money movement only through the executor package (architecture rules).
import { MoneyMovementClient } from "@witness/paypal/money-movement";
export const createMoneyMovementClient = (o: ConstructorParameters<typeof MoneyMovementClient>[0]) => new MoneyMovementClient(o);
