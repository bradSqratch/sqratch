/** Spoken form of a playback time for assistive technology, e.g. "1 minute 20 seconds". */
export function describePlaybackTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0 seconds";
  const whole = Math.floor(totalSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (hours) parts.push(unit(hours, "hour"));
  if (minutes) parts.push(unit(minutes, "minute"));
  if (seconds || parts.length === 0) parts.push(unit(seconds, "second"));
  return parts.join(" ");
}
