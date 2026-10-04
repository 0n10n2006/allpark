const INR_WHOLE = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

/** Formats an integer paise amount without losing precision to floating point math. */
export function formatINR(paise: number): string {
  if (!Number.isSafeInteger(paise)) {
    throw new RangeError("Paise must be a safe integer");
  }

  const sign = paise < 0 ? "-" : "";
  const absolutePaise = Math.abs(paise);
  const wholeRupees = Math.floor(absolutePaise / 100);
  const remainder = absolutePaise % 100;
  const amount =
    remainder === 0
      ? INR_WHOLE.format(wholeRupees)
      : `${INR_WHOLE.format(wholeRupees)}.${String(remainder).padStart(2, "0")}`;

  return `${sign}₹${amount}`;
}

/** Converts a rupee amount into integer paise, rejecting unsafe values. */
export function rupeesToPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) {
    throw new RangeError("Rupees must be a finite number");
  }

  const paise = Math.round((rupees + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(paise)) {
    throw new RangeError("Rupee amount exceeds safe integer paise range");
  }

  return paise;
}
