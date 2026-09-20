/**
 * Weather tools.
 *
 * Both are `read`: asking about the weather changes nothing, so neither should
 * prompt for confirmation. They are built by a factory so tests can inject a
 * fake WeatherService instead of reaching the network.
 */
import type { ToolDefinition } from './registry.js';
import { formatForecast, formatWeatherReport, formatLocation } from '../utils/weather-format.js';
import { OpenMeteoService, WeatherError, type WeatherService } from '../services/weather.js';

/** Facts consulted, in order, when the user does not name a place. */
const LOCATION_FACT_KEYS = ['home_city', 'location', 'city'];

const MAX_FORECAST_DAYS = 7;

/**
 * Resolves where to look. An explicit place wins; otherwise the stored home
 * city is used, which is the case that makes the weather useful at all — you
 * should not have to name your own city every time.
 */
async function resolveLocation(
  requested: string | undefined,
  service: WeatherService,
  facts: { key: string; value: string }[]
) {
  const explicit = requested?.trim();
  if (explicit) {
    return { location: await service.geocode(explicit), assumed: false };
  }

  for (const key of LOCATION_FACT_KEYS) {
    const match = facts.find((fact) => fact.key.toLowerCase() === key);
    if (match?.value?.trim()) {
      return { location: await service.geocode(match.value.trim()), assumed: true };
    }
  }

  return { location: undefined, assumed: false };
}

const NEEDS_LOCATION =
  'No location was given and none is stored. Ask the user which place they mean, ' +
  'or offer to remember their home city.';

export function createWeatherTools(service: WeatherService = new OpenMeteoService()): ToolDefinition[] {
  const current: ToolDefinition = {
    name: 'get_weather',
    description:
      "Current conditions and today's forecast for a place. Omit location to use the user's stored home city. " +
      'Use this for "what is the weather like", "is it raining", "do I need an umbrella".',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City or place name, e.g. "Singapore" or "Tokyo, Japan". Omit to use the stored home city.',
        },
      },
    },
    async execute(args, context) {
      try {
        const facts = await context.store.listFacts(context.userId);
        const resolved = await resolveLocation(
          typeof args.location === 'string' ? args.location : undefined,
          service,
          facts
        );

        if (!resolved.location) {
          return NEEDS_LOCATION;
        }

        const report = await service.forecast(resolved.location, 1, context.now);
        const note = resolved.assumed ? ' (their stored home city)' : '';
        return `${formatWeatherReport(report, true)}\nSource: Open-Meteo. Location assumed from their profile${note}.`;
      } catch (error) {
        if (error instanceof WeatherError) {
          // Returned rather than thrown, so the model can explain the problem
          // and offer an alternative instead of the turn failing outright.
          return `Weather lookup failed: ${error.message}`;
        }
        throw error;
      }
    },
  };

  const forecast: ToolDefinition = {
    name: 'get_forecast',
    description:
      'Multi-day weather outlook (up to 7 days) for a place. Use this for planning questions such as ' +
      '"will it rain on Saturday" or "what is the weekend looking like". Omit location to use the stored home city.',
    kind: 'read',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City or place name. Omit to use the stored home city.',
        },
        days: {
          type: 'integer',
          description: `How many days to cover, 1-${MAX_FORECAST_DAYS}. Defaults to 3.`,
          minimum: 1,
          maximum: MAX_FORECAST_DAYS,
        },
      },
    },
    async execute(args, context) {
      try {
        const facts = await context.store.listFacts(context.userId);
        const resolved = await resolveLocation(
          typeof args.location === 'string' ? args.location : undefined,
          service,
          facts
        );

        if (!resolved.location) {
          return NEEDS_LOCATION;
        }

        const days = typeof args.days === 'number' ? args.days : 3;
        const report = await service.forecast(resolved.location, days, context.now);
        const assumed = resolved.assumed ? ` (their stored home city is ${formatLocation(report.location)})` : '';
        return `${formatForecast(report)}\nSource: Open-Meteo.${assumed}`;
      } catch (error) {
        if (error instanceof WeatherError) {
          return `Weather lookup failed: ${error.message}`;
        }
        throw error;
      }
    },
  };

  return [current, forecast];
}
