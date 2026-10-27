export function validateReminderOwner(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('Invalid reminder owner.');
}

export function validateFutureInstant(value: string, now: Date): void {
  if (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= now.getTime()) {
    throw new Error('Reminder time must be in the future.');
  }
}

export function validateFollowUpBudget(localDate: string, maximum: number): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !Number.isFinite(Date.parse(localDate))
    || new Date(localDate).toISOString().slice(0, 10) !== localDate || !Number.isInteger(maximum) || maximum < 1 || maximum > 5) {
    throw new Error('Follow-up budget requires a valid date and maximum between 1 and 5.');
  }
}
