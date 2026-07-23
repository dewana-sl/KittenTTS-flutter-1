bool get benchmarkAutoStart => false;

void setBenchmarkBindings({
  required Future<void> Function() start,
  required String Function() reportJson,
  required String Function() audioChunksJson,
  required String? Function() error,
}) {}

void clearBenchmarkBindings() {}
