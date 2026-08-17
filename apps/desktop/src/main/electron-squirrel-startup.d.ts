// electron-squirrel-startup ships no types. It evaluates its Squirrel-event check at
// require time and exports the boolean result: true when the process was spawned by
// Squirrel to handle an install/update/uninstall shortcut event (win32 only), else
// false. See https://github.com/mongodb-js/electron-squirrel-startup.
declare module "electron-squirrel-startup" {
  const startedViaSquirrel: boolean;
  export default startedViaSquirrel;
}
