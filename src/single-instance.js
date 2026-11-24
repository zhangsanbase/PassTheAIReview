function acquireSingleInstance(app, getWindow) {
  const acquired = app.requestSingleInstanceLock();
  let pending = false, repeatCount = 0;
  function focusExisting() {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    pending = false;
  }
  if (!acquired) {
    app.quit();
  } else {
    app.on('second-instance', () => { repeatCount++; pending = true; focusExisting(); });
  }
  return {
    acquired,
    ready() { if (pending) focusExisting(); },
    get repeatCount() { return repeatCount; }
  };
}
module.exports = { acquireSingleInstance };
