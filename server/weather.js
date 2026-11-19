// 天气：城市天气驱动界面（Open-Meteo，无需 Key；失败时明确降级）
import { getRegion, regionLabel } from './regions.js';
import { getWeatherCache, setWeatherCache } from './db.js';

const WMO = {
  0: ['clear', '晴'], 1: ['clear', '大致晴朗'], 2: ['cloudy', '多云'], 3: ['cloudy', '阴'],
  45: ['fog', '雾'], 48: ['fog', '雾凇'],
  51: ['drizzle', '小毛毛雨'], 53: ['drizzle', '毛毛雨'], 55: ['drizzle', '密毛毛雨'],
  56: ['drizzle', '冻毛毛雨'], 57: ['drizzle', '强冻毛毛雨'],
  61: ['rain', '小雨'], 63: ['rain', '中雨'], 65: ['rain', '大雨'],
  66: ['rain', '冻雨'], 67: ['rain', '强冻雨'],
  71: ['snow', '小雪'], 73: ['snow', '中雪'], 75: ['snow', '大雪'], 77: ['snow', '雪粒'],
  80: ['rain', '阵雨'], 81: ['rain', '强阵雨'], 82: ['storm', '暴雨'],
  85: ['snow', '阵雪'], 86: ['snow', '强阵雪'],
  95: ['storm', '雷阵雨'], 96: ['storm', '雷阵雨伴冰雹'], 99: ['storm', '强雷暴伴冰雹']
};

function mapCode(code, isDay) {
  const [kind, text] = WMO[code] || ['cloudy', '未知'];
  return { kind, text, isDay: isDay === 1 };
}

/** 开发预览用：?mock=rain|storm|snow|fog|clear|night */
export function mockWeather(mock, cityCode) {
  const city = getRegion(cityCode);
  const map = {
    clear: { kind: 'clear', text: '晴', isDay: true },
    cloudy: { kind: 'cloudy', text: '多云', isDay: true },
    rain: { kind: 'rain', text: '小雨', isDay: true },
    storm: { kind: 'storm', text: '暴雨', isDay: true },
    snow: { kind: 'snow', text: '小雪', isDay: true },
    fog: { kind: 'fog', text: '雾', isDay: true },
    night: { kind: 'clear', text: '晴', isDay: false }
  };
  const w = map[mock] || map.clear;
  return {
    ok: true, mock: true, cityCode,
    cityName: city?.name || '', regionLabel: regionLabel(cityCode), temp: 18,
    ...w, updatedAt: new Date().toISOString()
  };
}

export async function getWeather(cityCode, { mock } = {}) {
  const city = getRegion(cityCode);
  if (!city) return { ok: false, error: 'city_not_found' };
  if (mock) return mockWeather(mock, cityCode);

  const cached = getWeatherCache(cityCode);
  if (cached) return { ok: true, ...cached, cityName: city.name, regionLabel: regionLabel(cityCode) };

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lng}`
      + '&current=temperature_2m,weather_code,is_day,precipitation,wind_speed_10m&timezone=Asia%2FShanghai';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const j = await res.json();
    const cur = j.current || {};
    const mapped = mapCode(cur.weather_code ?? 0, cur.is_day);
    const payload = {
      kind: mapped.kind, text: mapped.text, isDay: mapped.isDay,
      temp: Math.round(cur.temperature_2m ?? 0),
      precipitation: cur.precipitation ?? 0,
      wind: Math.round(cur.wind_speed_10m ?? 0),
      updatedAt: new Date().toISOString(),
      source: 'open-meteo'
    };
    setWeatherCache(cityCode, payload);
    return { ok: true, cityCode, cityName: city.name, regionLabel: regionLabel(cityCode), ...payload };
  } catch (err) {
    // 明确降级：告诉前端拿不到，让界面回到中性纸面，而不是假装晴天
    return { ok: false, error: 'weather_unavailable', detail: String(err.message || err), cityCode, cityName: city.name, regionLabel: regionLabel(cityCode) };
  }
}
