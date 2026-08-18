// Expo's Babel preset (Metro reads this at bundle time). babel-preset-expo pulls
// in expo-router's plugin automatically for SDK 50+, so no extra plugins are needed.
module.exports = (api) => {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
