/**
 * Weather lookups via Open-Meteo.
 *
 * Open-Meteo needs no API key, which is deliberate: this project already
 * carries a Telegram token, a Supabase service-role key and a model key, and a
 * weather feature does not justify a fourth credential to provision and rotate.
 *
 * The module exposes a small interface plus an HTTP implementation, so the
 * tools that use it can be tested without the network.
 */

export interface GeoLocation {
  name: string;
  country?: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface DailyForecast {
  /** Local date, "YYYY-MM-DD". */
  date: string;
  weatherCode: number;
  tempMax: number;
  tempMin: number;
  precipitationChance?: number;
  sunrise?: string;
  sunset?: string;
}

export interface CurrentConditions {
  /** Local time at the location, not the user's. */
  time: string;
  temperature: number;
  apparentTemperature?: number;
  humidity?: number;
  precipitation?: number;
  weatherCode: number;
  windSpeed?: number;
}

export interface WeatherReport {
  location: GeoLocation;
  current: CurrentConditions;
  /** Today first. */
  daily: DailyForecast[];
  fetchedAt: Date;
}

export class WeatherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeatherError';
  }
}

export interface WeatherService {
  geocode(place: string): Promise<GeoLocation>;
  forecast(location: GeoLocation, days: number, now: Date): Promise<WeatherReport>;
}

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/**
 * Weather changes, but not by the second. Caching for a few minutes means a
 * conversation that asks twice in a row costs one request, while the answer is
 * still current enough to act on.
 */
const FORECAST_TTL_MS = 10 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Live conditions plus a short forecast. Data is rounded to the units a person
 * would say out loud, so the model does not have to.
 */
export class OpenMeteoService implements WeatherService {
  private readonly fetchImpl: typeof fetch;
  private readonly geocodeCache = new Map<string, GeoLocation>();
  private readonly forecastCache = new Map<string, { report: WeatherReport }>();

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async geocode(place: string): Promise<GeoLocation> {
    const key = place.trim().toLowerCase();
    if (!key) {
      throw new WeatherError('No place name was given.');
    }

    const cached = this.geocodeCache.get(key);
    if (cached) {
      return cached;
    }

    const url = `${GEOCODE_URL}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
    const payload = await this.getJson<{
      results?: { name: string; country?: string; latitude: number; longitude: number; timezone?: string }[];
    }>(url);

    const hit = payload.results?.[0];
    if (!hit) {
      // The model can act on this: it should ask which place was meant rather
      // than guess coordinates.
      throw new WeatherError(`Could not find a place called "${place}".`);
    }

    const location: GeoLocation = {
      name: hit.name,
      ...(hit.country ? { country: hit.country } : {}),
      latitude: hit.latitude,
      longitude: hit.longitude,
      timezone: hit.timezone || 'UTC',
    };

    this.geocodeCache.set(key, location);
    return location;
  }

  async forecast(location: GeoLocation, days: number, now: Date): Promise<WeatherReport> {
    const clampedDays = Math.min(Math.max(Math.trunc(days) || 1, 1), 7);
    const key = `${location.latitude},${location.longitude},${clampedDays}`;
    const cached = this.forecastCache.get(key);

    if (cached && now.getTime() - cached.report.fetchedAt.getTime() < FORECAST_TTL_MS) {
      return cached.report;
    }

    const params = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
      timezone: location.timezone,
      forecast_days: String(clampedDays),
    });

    const payload = await this.getJson<{
      current?: Record<string, number | string>;
      daily?: Record<string, (number | string)[]>;
    }>(`${FORECAST_URL}?${params.toString()}`);

    if (!payload.current || !payload.daily) {
      throw new WeatherError('The weather service returned no data for that location.');
    }

    const daily = this.parseDaily(payload.daily);
    if (daily.length === 0) {
      throw new WeatherError('The weather service returned an empty forecast.');
    }

    const report: WeatherReport = {
      location,
      current: {
        time: String(payload.current.time ?? ''),
        temperature: Number(payload.current.temperature_2m),
        weatherCode: Number(payload.current.weather_code),
        ...(Number.isFinite(Number(payload.current.apparent_temperature))
          ? { apparentTemperature: Number(payload.current.apparent_temperature) }
          : {}),
        ...(Number.isFinite(Number(payload.current.relative_humidity_2m))
          ? { humidity: Number(payload.current.relative_humidity_2m) }
          : {}),
        ...(Number.isFinite(Number(payload.current.precipitation))
          ? { precipitation: Number(payload.current.precipitation) }
          : {}),
        ...(Number.isFinite(Number(payload.current.wind_speed_10m))
          ? { windSpeed: Number(payload.current.wind_speed_10m) }
          : {}),
      },
      daily,
      fetchedAt: now,
    };

    this.forecastCache.set(key, { report });
    return report;
  }

  /** Exposed so tests can check that caching actually happens. */
  clearCache(): void {
    this.geocodeCache.clear();
    this.forecastCache.clear();
  }

  private parseDaily(raw: Record<string, (number | string)[]>): DailyForecast[] {
    const dates = (raw.time ?? []) as string[];
    const code = (raw.weather_code ?? []) as number[];
    const max = (raw.temperature_2m_max ?? []) as number[];
    const min = (raw.temperature_2m_min ?? []) as number[];
    const precip = (raw.precipitation_probability_max ?? []) as (number | null)[];
    const sunrise = (raw.sunrise ?? []) as string[];
    const sunset = (raw.sunset ?? []) as string[];

    return dates.map((date, index) => ({
      date,
      weatherCode: Number(code[index] ?? 0),
      tempMax: Number(max[index]),
      tempMin: Number(min[index]),
      ...(precip[index] != null ? { precipitationChance: Number(precip[index]) } : {}),
      ...(sunrise[index] ? { sunrise: String(sunrise[index]) } : {}),
      ...(sunset[index] ? { sunset: String(sunset[index]) } : {}),
    }));
  }

  private async getJson<T>(url: string): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new WeatherError(`Could not reach the weather service (${reason}).`);
    }

    if (!response.ok) {
      throw new WeatherError(`The weather service returned HTTP ${response.status}.`);
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new WeatherError('The weather service returned a response that could not be read.');
    }
  }
}
