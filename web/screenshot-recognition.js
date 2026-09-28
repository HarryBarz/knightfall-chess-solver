(() => {
  let modulePromise;

  window.KnightfallRecognition = Object.freeze({
    async recognize(file) {
      modulePromise ||= import('/vendor/screenshot/recognizer.mjs').catch(error => {
        modulePromise = undefined;
        throw error;
      });
      const module = await modulePromise;
      return module.recognize(file);
    },
  });
})();
