/**
 * Turns a weather report into text a model can relay without inventing
 * anything.
 *
 * The output is deliberately explicit — numbers with units, and conditions
 * spelled out — because the model paraphrases whatever it is given. Summarising
 * here in vague terms ("fair") would leave it guessing at the detail the user
 * actually asked about.
 */
import type { DailyForecast, GeoLocation, WeatherReport } from '../services/weather.js';

/** WMO weather interpretation codes, as used by Open-Meteo. */
const WMO_DESCRIPTIONS: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'dense freezing drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'heavy freezing rain',
  71: 'slight snow',
  73: 'moderate snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'slight rain showers',
  81: 'moderate rain showers',
  82: 'violent rain showers',
  85: 'slight snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
};

export function describeWeatherCode(code: number): string {
  // Unknown codes are described as such rather than guessed at: a wrong
  // condition is worse than an admitted unknown.
  return WMO_DESCRIPTIONS[code] ?? `unknown conditions (code ${code})`;
}

/** Rounds to whole degrees; weather precision beyond that is noise. */
function degrees(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return 'unknown';
  }
  return `${Math.round(value)} °C`;
}

export function formatLocation(location: GeoLocation): string {
  return location.country ? `${location.name}, ${location.country}` : location.name;
}

/** Formats a "YYYY-MM-DD" date as a weekday name, for "will it rain Saturday?". */
export function weekdayOf(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(parsed);
}

export function formatDailyLine(day: DailyForecast, todayDate?: string): string {
  const label = todayDate && day.date === todayDate ? 'today' : weekdayOf(day.date);
  const parts = [
    `${label} (${day.date}): ${describeWeatherCode(day.weatherCode)}`,
    `${degrees(day.tempMin)} to ${degrees(day.tempMax)}`,
  ];

  if (day.precipitationChance !== undefined) {
    parts.push(`${Math.round(day.precipitationChance)}% chance of precipitation`);
  }
  if (day.sunrise && day.sunset) {
    // Times arrive as full ISO strings; only the clock part is useful.
    parts.push(`sun ${day.sunrise.slice(11, 16)}–${day.sunset.slice(11, 16)}`);
  }

  return parts.join(', ');
}

/**
 * Renders a full report. `current` is included only for the first day, since
 * "current conditions" for a future date would be meaningless.
 */
export function formatWeatherReport(report: WeatherReport, includeCurrent = true): string {
  const lines: string[] = [`Weather for ${formatLocation(report.location)} (local time ${report.location.timezone}).`];

  if (includeCurrent) {
    const current = report.current;
    const detail = [
      `${degrees(current.temperature)}`,
      describeWeatherCode(current.weatherCode),
    ];
    if (current.apparentTemperature !== undefined && current.apparentTemperature !== current.temperature) {
      detail.push(`feels like ${degrees(current.apparentTemperature)}`);
    }
    if (current.humidity !== undefined) {
      detail.push(`${Math.round(current.humidity)}% humidity`);
    }
    if (current.windSpeed !== undefined) {
      detail.push(`${Math.round(current.windSpeed)} km/h wind`);
    }
    lines.push(`Right now (${current.time.slice(11, 16)}): ${detail.join(', ')}.`);
  }

  const today = report.daily[0]?.date;
  for (const day of report.daily) {
    lines.push(formatDailyLine(day, today));
  }

  return lines.join('\n');
}

/**
 * A compact multi-day outlook, for questions like "what's the weekend looking
 * like" where the current conditions add nothing.
 */
export function formatForecast(report: WeatherReport): string {
  return formatWeatherReport(report, false);
}
