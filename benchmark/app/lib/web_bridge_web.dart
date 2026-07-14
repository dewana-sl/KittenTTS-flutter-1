// ignore_for_file: non_constant_identifier_names

import 'dart:js_interop';

@JS('globalThis')
external JSObject get _globalThis;

extension type _BenchmarkGlobal(JSObject _) implements JSObject {
  external set __KITTEN_START_BENCHMARK__(JSFunction? value);
  external set __KITTEN_GET_BENCHMARK_REPORT_JSON__(JSFunction? value);
  external set __KITTEN_GET_BENCHMARK_ERROR__(JSFunction? value);
}

bool get benchmarkAutoStart {
  return Uri.base.queryParameters['benchmarkAutoStart'] == 'true';
}

void setBenchmarkBindings({
  required Future<void> Function() start,
  required String Function() reportJson,
  required String? Function() error,
}) {
  final global = _BenchmarkGlobal(_globalThis);
  global.__KITTEN_START_BENCHMARK__ = (() {
    start();
  }).toJS;
  global.__KITTEN_GET_BENCHMARK_REPORT_JSON__ = (() => reportJson()).toJS;
  global.__KITTEN_GET_BENCHMARK_ERROR__ = (() => error() ?? '').toJS;
}

void clearBenchmarkBindings() {
  final global = _BenchmarkGlobal(_globalThis);
  global.__KITTEN_START_BENCHMARK__ = null;
  global.__KITTEN_GET_BENCHMARK_REPORT_JSON__ = null;
  global.__KITTEN_GET_BENCHMARK_ERROR__ = null;
}
