declare const __AIRWOLF_BUILD__: string;
export const buildRevision =
  typeof __AIRWOLF_BUILD__ === 'string' ? __AIRWOLF_BUILD__ : 'development';
