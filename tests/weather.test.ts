/**
 * Weather tests.
 *
 * The network layer is stubbed via the WeatherService interface and a fake
 * fetch, so these cover the logic that would otherwise only fail in
 * production: code mapping, location fallback, caching, and error surfacing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OpenMeteoService, WeatherError, type WeatherReport } from '../src/services/weather.js';
import { describeWeatherCode, formatDailyLine, formatWeatherReport, formatForecast, weekdayOf } from '../src/utils/weather-format.js';
import { createWeatherTools } from '../src/tools/weather-tools.js';
import type { ToolContext } from '../src/tools/registry.js';
import type { AssistantStore } from '../src/services/assistant-store.js';
import { InMemoryAssistantStore } from '../src/services/in-memory-assistant-store.js';

// --- Formatting ------------------------------------------------------------

test('WMO codes map to plain descriptions', () => {
  assert.equal(describeWeatherCode(0), 'clear sky');
  assert.equal(describeWeatherCode(63), 'moderate rain');
  assert.equal(describeWeatherCode(95), 'thunderstorm');
  assert.equal(describeWeatherCode(99), 'thunderstorm with heavy hail');
});

test('an unknown WMO code is admitted rather than guessed', () => {
  // Inventing a condition would be worse than saying it is unknown: the user
  // would act on a fiction.
  const described = describeWeatherCode(1234);

  assert.match(described, /unknown/i);
  assert.match(described, /1234/);
});

test('a weekday is derived from the date', () => {
  // 2026-09-19 is a Saturday.
  assert.equal(weekdayOf('2026-09-19'), 'Saturday');
  assert.equal(weekdayOf('2026-09-20'), 'Sunday');
});

test('a daily line reads as a sentence, with units', () => {
  const line = formatDailyLine(
    {
      date: '2026-09-19',
      weatherCode: 61,
      tempMax: 31.4,
      tempMin: 26.2,
      precipitationChance: 80,
      sunrise: '2026-09-19T06:58',
      sunset: '2026-09-19T19:02',
    },
    '2026-09-19'
  );

  assert.match(line, /today \(2026-09-19\)/);
  assert.match(line, /slight rain/);
  assert.match(line, /26 °C to 31 °C/);
  assert.match(line, /80% chance of precipitation/);
  assert.match(line, /sun 06:58–19:02/);
});

test('a missing precipitation figure is omitted, not shown as zero', () => {
  // "0% chance" and "no data" are different claims.
  const line = formatDailyLine({ date: '2026-09-19', weatherCode: 0, tempMax: 30, tempMin: 20 });

  assert.doesNotMatch(line, /precipitation/);
});

test('a full report includes current conditions and the location timezone', () => {
  const report: WeatherReport = {
    location: { name: 'Singapore', country: 'Singapore', latitude: 1.29, longitude: 103.85, timezone: 'Asia/Singapore' },
    current: {
      time: '2026-09-20T22:45',
      temperature: 28.5,
      apparentTemperature: 33.9,
      humidity: 75,
      weatherCode: 1,
      windSpeed: 2.6,
    },
    daily: [{ date: '2026-09-20', weatherCode: 1, tempMax: 31, tempMin: 26 }],
    fetchedAt: new Date(),
  };

  const text = formatWeatherReport(report);

  assert.match(text, /Singapore, Singapore/);
  assert.match(text, /Asia\/Singapore/);
  assert.match(text, /Right now \(22:45\)/);
  assert.match(text, /29 °C/);
  assert.match(text, /feels like 34 °C/);
  assert.match(text, /75% humidity/);
});

test('the outlook omits current conditions, which are meaningless for future days', () => {
  const report: WeatherReport = {
    location: { name: 'Tokyo', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' },
    current: { time: '2026-09-20T22:45', temperature: 20, weatherCode: 0 },
    daily: [
      { date: '2026-09-20', weatherCode: 0, tempMax: 25, tempMin: 15 },
      { date: '2026-09-21', weatherCode: 3, tempMax: 24, tempMin: 16 },
    ],
    fetchedAt: new Date(),
  };

  const text = formatForecast(report);

  assert.doesNotMatch(text, /Right now/);
  // The first day reads as "today" rather than its weekday name, which is how a
  // person would refer to it.
  assert.match(text, /today \(2026-09-20\)/);
  assert.match(text, /Monday \(2026-09-21\)/);
});

// --- Service: caching and errors -------------------------------------------

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

test('the geocoder result is cached, so one place costs one request', async () => {
  let calls = 0;
  const service = new OpenMeteoService((async () => {
    calls += 1;
    return jsonResponse({ results: [{ name: 'Singapore', country: 'Singapore', latitude: 1.29, longitude: 103.85, timezone: 'Asia/Singapore' }] });
  }) as unknown as typeof fetch);

  await service.geocode('Singapore');
  await service.geocode('singapore'); // different case, same place

  assert.equal(calls, 1, 'the second lookup was served from cache');
});

test('geocoding an unknown place reports it as unknown', async () => {
  const service = new OpenMeteoService((async () => jsonResponse({ results: [] })) as unknown as typeof fetch);

  await assert.rejects(() => service.geocode('Nowhereville'), (error: Error) => {
    assert.ok(error instanceof WeatherError);
    assert.match(error.message, /Could not find a place called/);
    return true;
  });
});

test('an empty place name is rejected before any request', async () => {
  let called = false;
  const service = new OpenMeteoService((async () => {
    called = true;
    return jsonResponse({});
  }) as unknown as typeof fetch);

  await assert.rejects(() => service.geocode('   '), WeatherError);
  assert.equal(called, false);
});

test('a forecast is cached briefly, so repeated questions cost one request', async () => {
  let calls = 0;
  const service = new OpenMeteoService((async () => {
    calls += 1;
    return jsonResponse({
      current: { time: '2026-09-20T22:45', temperature_2m: 28, weather_code: 1 },
      daily: {
        time: ['2026-09-20'],
        weather_code: [1],
        temperature_2m_max: [31],
        temperature_2m_min: [26],
      },
    });
  }) as unknown as typeof fetch);

  const location = { name: 'Singapore', latitude: 1.29, longitude: 103.85, timezone: 'Asia/Singapore' };
  const now = new Date('2026-09-20T22:45:00Z');

  await service.forecast(location, 3, now);
  await service.forecast(location, 3, new Date(now.getTime() + 60_000));

  assert.equal(calls, 1, 'within the TTL the cached report is reused');
});

test('the cache expires, so stale weather is not served indefinitely', async () => {
  let calls = 0;
  const service = new OpenMeteoService((async () => {
    calls += 1;
    return jsonResponse({
      current: { time: '2026-09-20T22:45', temperature_2m: 28, weather_code: 1 },
      daily: { time: ['2026-09-20'], weather_code: [1], temperature_2m_max: [31], temperature_2m_min: [26] },
    });
  }) as unknown as typeof fetch);

  const location = { name: 'Singapore', latitude: 1.29, longitude: 103.85, timezone: 'Asia/Singapore' };
  const now = new Date('2026-09-20T22:45:00Z');

  await service.forecast(location, 3, now);
  await service.forecast(location, 3, new Date(now.getTime() + 30 * 60_000));

  assert.equal(calls, 2, 'past the TTL a fresh request is made');
});

test('a network failure is reported as a WeatherError, not a raw crash', async () => {
  const service = new OpenMeteoService((async () => {
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch);

  await assert.rejects(() => service.geocode('Singapore'), (error: Error) => {
    assert.ok(error instanceof WeatherError);
    assert.match(error.message, /Could not reach the weather service/);
    return true;
  });
});

test('an HTTP error surfaces the status', async () => {
  const service = new OpenMeteoService((async () => jsonResponse({}, 503)) as unknown as typeof fetch);

  await assert.rejects(() => service.geocode('Singapore'), /HTTP 503/);
});

test('an unreadable body is reported rather than crashing', async () => {
  const service = new OpenMeteoService((async () =>
    ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }) as unknown as Response) as unknown as typeof fetch);

  await assert.rejects(() => service.geocode('Singapore'), /could not be read/);
});

test('a response with no forecast data is rejected', async () => {
  const service = new OpenMeteoService((async () => jsonResponse({ current: {} })) as unknown as typeof fetch);

  await assert.rejects(
    () => service.forecast({ name: 'X', latitude: 1, longitude: 1, timezone: 'UTC' }, 1, new Date()),
    /no data for that location/
  );
});

// --- Tools -----------------------------------------------------------------

/** Stub service, so tool behaviour is tested without touching the network. */
class FakeWeather {
  geocoded: string[] = [];
  forecastCalls: { days: number }[] = [];

  constructor(private readonly failWith?: string) {}

  async geocode(place: string) {
    this.geocoded.push(place);
    if (this.failWith) {
      throw new WeatherError(this.failWith);
    }
    return { name: place, country: 'Testland', latitude: 1, longitude: 2, timezone: 'UTC' };
  }

  async forecast(_location: unknown, days: number, now: Date): Promise<WeatherReport> {
    this.forecastCalls.push({ days });
    return {
      location: { name: 'Testville', country: 'Testland', latitude: 1, longitude: 2, timezone: 'UTC' },
      current: { time: '2026-09-20T12:00', temperature: 20, weatherCode: 0 },
      daily: [{ date: '2026-09-20', weatherCode: 0, tempMax: 22, tempMin: 12 }],
      fetchedAt: now,
    };
  }
}

function contextWith(store: AssistantStore): ToolContext {
  return { userId: 1, store, timezone: 'UTC', now: new Date('2026-09-20T12:00:00Z') };
}

function toolsByName(service: unknown) {
  const tools = createWeatherTools(service as never);
  return {
    current: tools.find((tool) => tool.name === 'get_weather')!,
    forecast: tools.find((tool) => tool.name === 'get_forecast')!,
  };
}

test('weather tools are read-only, so they never prompt for confirmation', () => {
  const { current, forecast } = toolsByName(new FakeWeather());

  assert.equal(current.kind, 'read');
  assert.equal(forecast.kind, 'read');
});

test('an explicitly named place is used', async () => {
  const service = new FakeWeather();
  const { current } = toolsByName(service);
  const store = new InMemoryAssistantStore();

  const result = await current.execute({ location: 'Tokyo' }, contextWith(store));

  assert.deepEqual(service.geocoded, ['Tokyo']);
  assert.match(result, /Testville/);
});

test('with no place named, the stored home city is used', async () => {
  // This is what makes the weather useful: you should not have to name your own
  // city every time you ask.
  const service = new FakeWeather();
  const { current } = toolsByName(service);
  const store = new InMemoryAssistantStore();
  await store.saveFact(1, 'home_city', 'Singapore', 'core');

  const result = await current.execute({}, contextWith(store));

  assert.deepEqual(service.geocoded, ['Singapore']);
  assert.match(result, /stored home city/);
});

test('with no place and no stored city, the model is told to ask', async () => {
  const service = new FakeWeather();
  const { current } = toolsByName(service);
  const store = new InMemoryAssistantStore();

  const result = await current.execute({}, contextWith(store));

  assert.match(result, /Ask the user which place/);
  assert.deepEqual(service.geocoded, [], 'no lookup was attempted');
});

test('an unknown place is reported so the model can ask for clarification', async () => {
  const service = new FakeWeather('Could not find a place called "Nowhereville".');
  const { current } = toolsByName(service);

  const result = await current.execute({ location: 'Nowhereville' }, contextWith(new InMemoryAssistantStore()));

  // Returned, not thrown: the turn should continue so the model can explain.
  assert.match(result, /Weather lookup failed/);
  assert.match(result, /Could not find/);
});

test('the forecast tool defaults to three days and respects an explicit count', async () => {
  const service = new FakeWeather();
  const { forecast } = toolsByName(service);
  const store = new InMemoryAssistantStore();

  await forecast.execute({ location: 'Oslo' }, contextWith(store));
  await forecast.execute({ location: 'Oslo', days: 5 }, contextWith(store));

  assert.deepEqual(service.forecastCalls, [{ days: 3 }, { days: 5 }]);
});

test('the tools declare their parameters for the model', () => {
  const { current, forecast } = toolsByName(new FakeWeather());

  assert.ok(current.parameters.properties.location);
  assert.deepEqual(forecast.parameters.properties.days.type, 'integer');
  assert.equal(forecast.parameters.properties.days.maximum, 7);
});
