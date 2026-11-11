import { stringToHex } from "viem";
export { exchangeAbi, hedgeManagerAbi } from "@parallel/shared";

/** Currency codes are stored onchain as bytes32 (left-aligned ASCII). */
export const stringToHexBytes32 = (s: string) => stringToHex(s, { size: 32 });
