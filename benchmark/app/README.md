# KittenTTS Flutter Benchmark App

This app is used by CI to benchmark the local checkout of `kittentts_flutter`
on Android, iOS, and web. It is intentionally separate from the public examples.

The app runs every bundled model with one cold generation and five warm
generations, then exposes:

- timing and RTF metrics as JSON
- WAV audio chunks for WER and Google Drive upload
- row-level error details when a model fails

Useful local checks:

```sh
flutter pub get
flutter analyze
flutter test
flutter build web --release
flutter build apk --release
```
