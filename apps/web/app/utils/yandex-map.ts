export type Coordinates = [number, number];
interface MapEvent { get(name: string): unknown }
export interface MapAddress {
  geometry: { getCoordinates(): Coordinates };
  properties: { get(name: string): unknown };
  getLocalities(): string[];
  getAdministrativeAreas(): string[];
  getThoroughfare(): string;
  getPremiseNumber(): string;
}
interface SearchControl {
  events: { add(name: string, handler: (event: MapEvent) => void): void };
  getResultsArray(): MapAddress[];
  getResult(index: number): PromiseLike<MapAddress>;
}
export interface DeliveryMap {
  events: { add(name: string, handler: (event: MapEvent) => void): void };
  geoObjects: { add(object: MapMarker): void; remove(object: MapMarker): void };
  controls: { get(name: string): SearchControl };
  setCenter(coordinates: Coordinates, zoom?: number): PromiseLike<void>;
  destroy(): void;
}
export interface MapMarker { geometry: { setCoordinates(coordinates: Coordinates): void } }
export interface YandexMaps {
  ready(success: () => void, error: () => void): void;
  Map: new (element: HTMLElement, state: {
    center: Coordinates; zoom: number; controls: string[];
  }, options: {
    searchControlProvider: string;
    searchControlNoPlacemark: boolean;
    searchControlNoCentering: boolean;
    searchControlUseMapBounds: boolean;
  }) => DeliveryMap;
  Placemark: new (coordinates: Coordinates, properties: object, options: object) => MapMarker;
  geocode(request: Coordinates | string, options: { results: number; kind?: string }): PromiseLike<{
    geoObjects: { get(index: number): MapAddress | undefined };
  }>;
}

let loading: Promise<YandexMaps> | undefined;
export function loadDeliveryMap(key: string, suggestKey: string) {
  if (loading) return loading;
  const task = new Promise<YandexMaps>((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(fail, 15_000);
    function fail() {
      clearTimeout(timer);
      script.remove();
      reject(new Error('Не удалось загрузить карту'));
    }
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(key)}&lang=ru_RU${suggestKey ? `&suggest_apikey=${encodeURIComponent(suggestKey)}` : ''}`;
    script.async = true;
    script.onerror = fail;
    script.onload = () => {
      const maps = (window as Window & { ymaps?: YandexMaps }).ymaps;
      if (!maps) return fail();
      maps.ready(() => { clearTimeout(timer); resolve(maps); }, fail);
    };
    document.head.append(script);
  });
  loading = task;
  void task.catch(() => { if (loading === task) loading = undefined; });
  return task;
}
