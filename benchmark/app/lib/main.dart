import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:kittentts_flutter/kittentts_flutter.dart';

import 'benchmark_model_assets.dart';
import 'web_bridge.dart';

void main() {
  runApp(const KittenBenchmarkApp());
}

const _defaultSampleText = String.fromEnvironment(
  'TESTMU_SAMPLE_TEXT',
  defaultValue:
      'KittenTTS runs fully on your device and creates clear speech quickly.\n'
      'This benchmark compares every model for speed, quality, and consistency.',
);
const _warmRunCount = int.fromEnvironment('TESTMU_WARM_RUNS', defaultValue: 5);
const _voice = 'bella';
const _speed = 1.0;
const _audioChunkSize = 64000;

const _background = Color(0xFFF8FAFC);
const _foreground = Color(0xFF101828);
const _muted = Color(0xFF667085);
const _line = Color(0xFFD0D5DD);
const _primary = Color(0xFF155EEF);

class KittenBenchmarkApp extends StatelessWidget {
  const KittenBenchmarkApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KittenTTS Flutter Benchmark',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _primary,
          primary: _primary,
          surface: Colors.white,
        ),
        scaffoldBackgroundColor: _background,
      ),
      home: const KittenBenchmarkPage(),
    );
  }
}

class KittenBenchmarkPage extends StatefulWidget {
  const KittenBenchmarkPage({super.key});

  @override
  State<KittenBenchmarkPage> createState() => _KittenBenchmarkPageState();
}

class _KittenBenchmarkPageState extends State<KittenBenchmarkPage> {
  final _textController = TextEditingController(text: _defaultSampleText);
  late final Future<_BenchmarkPhonemizerData> _phonemizerDataFuture;

  var _status = 'Ready';
  var _running = false;
  String? _errorMessage;
  Map<String, Object?>? _report;
  String _reportJson = '';
  List<_AudioChunk> _audioChunks = const [];
  var _audioPagerIndex = 0;

  @override
  void initState() {
    super.initState();
    _phonemizerDataFuture = _loadBenchmarkPhonemizerData();
    setBenchmarkBindings(
      start: _runBenchmark,
      reportJson: () => _reportJson,
      error: () => _errorMessage,
    );
    if (benchmarkAutoStart) {
      scheduleMicrotask(_runBenchmark);
    }
  }

  @override
  void dispose() {
    _textController.dispose();
    clearBenchmarkBindings();
    super.dispose();
  }

  Future<void> _runBenchmark() async {
    if (_running) return;

    final sampleText = _textController.text.trim();
    if (sampleText.isEmpty) {
      setState(() => _errorMessage = 'Sample text is empty.');
      return;
    }

    final startedAt = DateTime.now().toUtc();
    final rows = allKittenTTSModelIds.map(_queuedBenchmarkRow).toList();
    final chunks = <_AudioChunk>[];
    final phonemizerData = await _phonemizerDataFuture;

    setState(() {
      _running = true;
      _status = 'Starting benchmark';
      _errorMessage = null;
      _reportJson = '';
      _report = {
        'schemaVersion': 1,
        'status': 'running',
        'sampleText': sampleText,
        'characterLength': sampleText.characters.length,
        'voice': _voice,
        'voiceDisplayName': voiceDisplayName(_voice),
        'speed': _speed,
        'warmRunCount': _warmRunCount,
        'startedAt': startedAt.toIso8601String(),
        'finishedAt': null,
        'rows': rows,
      };
    });

    _publishPartialReport(sampleText, startedAt, rows, chunks);

    for (final entry in allKittenTTSModelIds.asMap().entries) {
      final modelId = entry.value;
      final modelName = modelRepoId(modelId);
      final row = rows[entry.key];
      _publishPartialReport(sampleText, startedAt, rows, chunks);

      KittenTTS? tts;
      try {
        _setStatus('Loading ${modelDisplayName(modelId)}');
        final modelFiles = await resolveBenchmarkModelFiles(modelId);
        final loadStarted = Stopwatch()..start();
        tts = await KittenTTS.create(
          config: KittenTTSConfig(
            model: modelId,
            analytics: false,
            modelFiles: modelFiles,
            phonemizer: CEPhonemizer(
              rulesText: phonemizerData.rulesText,
              listText: phonemizerData.listText,
            ),
          ),
          onProgress: (progress, [info]) {
            final percent = (progress * 100).clamp(0, 100).toStringAsFixed(0);
            _setStatus('Loading ${modelDisplayName(modelId)} $percent%');
          },
        );
        loadStarted.stop();

        _setStatus('Cold run ${modelDisplayName(modelId)}');
        final first = await _timedGenerate(tts, sampleText);
        final warm = <_TimedGeneration>[];

        for (var index = 0; index < _warmRunCount; index += 1) {
          _setStatus(
            'Warm run ${index + 1}/$_warmRunCount ${modelDisplayName(modelId)}',
          );
          warm.add(await _timedGenerate(tts, sampleText));
        }

        final best = warm.reduce(
          (currentBest, item) =>
              item.generationMs < currentBest.generationMs ? item : currentBest,
        );
        final warmMs = warm.map((item) => item.generationMs).toList();
        final warmSeconds = warm
            .map((item) => _round(item.generationMs / 1000))
            .toList();
        final warmRtf = warm
            .map((item) => _round((item.generationMs / 1000) / item.duration))
            .toList();
        final wavBase64 = best.result.wavBase64();
        final rowSlug = _slugify(modelName);
        final rowChunks = _splitAudio(rowSlug, wavBase64);
        chunks.addAll(rowChunks);

        row
          ..clear()
          ..addAll({
            'model': modelName,
            'modelId': modelId,
            'modelDisplayName': modelDisplayName(modelId),
            'status': 'passed',
            'loadMs': loadStarted.elapsedMilliseconds,
            'loadSeconds': _round(loadStarted.elapsedMilliseconds / 1000),
            'firstGenerationMs': first.generationMs,
            'firstGenerationSeconds': _round(first.generationMs / 1000),
            'generationMs': best.generationMs,
            'generationSeconds': _round(best.generationMs / 1000),
            'warmRunCount': _warmRunCount,
            'warmGenerationMs': warmMs,
            'warmGenerationSeconds': warmSeconds,
            'warmP50GenerationMs': _percentile(warmMs, 0.50).round(),
            'warmP50GenerationSeconds': _round(
              _percentile(warmMs, 0.50) / 1000,
            ),
            'warmP95GenerationMs': _percentile(warmMs, 0.95).round(),
            'warmP95GenerationSeconds': _round(
              _percentile(warmMs, 0.95) / 1000,
            ),
            'durationSeconds': _round(best.duration),
            'rtf': _round((best.generationMs / 1000) / best.duration),
            'warmRtf': warmRtf,
            'warmP50Rtf': _round(_percentile(warmRtf, 0.50)),
            'warmP95Rtf': _round(_percentile(warmRtf, 0.95)),
            'sampleCount': best.result.samples.length,
            'sampleRate': best.result.sampleRate,
            'sampleHash': _hashBytes(best.result.wavData()),
            'werReferenceText': sampleText,
            'werAudioFormat': 'wav-base64',
            'werAudioSampleRate': best.result.sampleRate,
            'werAudioBase64Length': wavBase64.length,
            'werAudioChunkCount': rowChunks.length,
            'parakeetStatus': 'pending',
          });
      } catch (error, stackTrace) {
        row
          ..clear()
          ..addAll({
            'model': modelName,
            'modelId': modelId,
            'modelDisplayName': modelDisplayName(modelId),
            'status': 'failed',
            'failedStage': _status,
            'errorSummary': _friendlyError(error),
            'errorDetails': stackTrace
                .toString()
                .split('\n')
                .take(8)
                .join('\n'),
          });
      } finally {
        await tts?.dispose();
        _publishPartialReport(sampleText, startedAt, rows, chunks);
      }
    }

    final finishedAt = DateTime.now().toUtc();
    final failed = rows.any((row) => row['status'] == 'failed');
    final finalReport = _buildReport(
      sampleText: sampleText,
      startedAt: startedAt,
      finishedAt: finishedAt,
      status: failed ? 'partial' : 'passed',
      rows: rows,
    );

    setState(() {
      _running = false;
      _status = failed
          ? 'Benchmark finished with model failures'
          : 'Benchmark finished';
      _report = finalReport;
      _reportJson = const JsonEncoder.withIndent('  ').convert(finalReport);
      _audioChunks = chunks;
      _audioPagerIndex = 0;
    });
  }

  Future<_TimedGeneration> _timedGenerate(KittenTTS tts, String text) async {
    final timer = Stopwatch()..start();
    final result = await tts.generate(text, voice: _voice, speed: _speed);
    timer.stop();
    return _TimedGeneration(
      result: result,
      generationMs: max(1, timer.elapsedMilliseconds),
    );
  }

  void _setStatus(String status) {
    if (!mounted) return;
    setState(() => _status = status);
  }

  Map<String, Object?> _queuedBenchmarkRow(KittenTTSModelId modelId) {
    return {
      'model': modelRepoId(modelId),
      'modelId': modelId,
      'modelDisplayName': modelDisplayName(modelId),
      'status': 'failed',
      'failedStage': 'Queued',
      'errorSummary': 'Model did not run yet.',
    };
  }

  void _publishPartialReport(
    String sampleText,
    DateTime startedAt,
    List<Map<String, Object?>> rows,
    List<_AudioChunk> chunks,
  ) {
    if (!mounted) return;
    final report = _buildReport(
      sampleText: sampleText,
      startedAt: startedAt,
      status: 'running',
      rows: rows,
    );
    setState(() {
      _report = report;
      _reportJson = const JsonEncoder.withIndent('  ').convert(report);
      _audioChunks = List.unmodifiable(chunks);
    });
  }

  Map<String, Object?> _buildReport({
    required String sampleText,
    required DateTime startedAt,
    required String status,
    required List<Map<String, Object?>> rows,
    DateTime? finishedAt,
  }) {
    return {
      'schemaVersion': 1,
      'status': status,
      'sampleText': sampleText,
      'characterLength': sampleText.characters.length,
      'voice': _voice,
      'voiceDisplayName': voiceDisplayName(_voice),
      'speed': _speed,
      'warmRunCount': _warmRunCount,
      'startedAt': startedAt.toIso8601String(),
      'finishedAt': finishedAt?.toIso8601String(),
      'rows': rows,
    };
  }

  List<_AudioChunk> _splitAudio(String rowSlug, String wavBase64) {
    final chunks = <_AudioChunk>[];
    for (var offset = 0; offset < wavBase64.length; offset += _audioChunkSize) {
      final index = chunks.length;
      chunks.add(
        _AudioChunk(
          key: '$rowSlug-$index',
          accessibilityId: 'benchmark-audio-$rowSlug-$index',
          value: wavBase64.substring(
            offset,
            min(offset + _audioChunkSize, wavBase64.length),
          ),
        ),
      );
    }
    return chunks;
  }

  String _friendlyError(Object error) {
    final message = error.toString();
    if (message.length <= 500) return message;
    return '${message.substring(0, 500)}...';
  }

  @override
  Widget build(BuildContext context) {
    final currentChunk = _audioChunks.isEmpty
        ? null
        : _audioChunks[_audioPagerIndex.clamp(0, _audioChunks.length - 1)];

    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Semantics(
              label: 'benchmark-json-display',
              value: _reportJson.isEmpty ? '{}' : _reportJson,
              child: const SizedBox(height: 1, width: 1),
            ),
            ..._audioChunks.map(
              (chunk) => Semantics(
                label: chunk.accessibilityId,
                value: chunk.value,
                child: const SizedBox(height: 1, width: 1),
              ),
            ),
            const Text(
              'KittenTTS Flutter Benchmark',
              style: TextStyle(
                color: _foreground,
                fontSize: 28,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Runs every model locally and exports timing, RTF, WER audio, and errors for CI.',
              style: TextStyle(color: _muted, fontSize: 15),
            ),
            const SizedBox(height: 20),
            Semantics(
              label: 'tts-input',
              textField: true,
              child: TextField(
                controller: _textController,
                enabled: !_running,
                minLines: 3,
                maxLines: 5,
                decoration: const InputDecoration(
                  labelText: 'Sample text',
                  border: OutlineInputBorder(),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Semantics(
              label: 'benchmark-button',
              button: true,
              enabled: !_running,
              child: FilledButton(
                onPressed: _running ? null : _runBenchmark,
                child: Text(_running ? 'Running benchmark' : 'Run benchmark'),
              ),
            ),
            const SizedBox(height: 12),
            Semantics(
              label: 'status-label',
              value: _status,
              child: Text(
                _status,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
            if (_errorMessage != null) ...[
              const SizedBox(height: 12),
              Semantics(
                label: 'error-message',
                value: _errorMessage,
                child: Text(
                  _errorMessage!,
                  style: const TextStyle(color: Colors.red),
                ),
              ),
            ],
            const SizedBox(height: 18),
            _ResultSummary(report: _report),
            const SizedBox(height: 18),
            if (currentChunk != null) ...[
              Row(
                children: [
                  Expanded(
                    child: Semantics(
                      label: 'benchmark-audio-current-key',
                      value: currentChunk.key,
                      child: Text(
                        'Audio chunk ${_audioPagerIndex + 1}/${_audioChunks.length}',
                        style: const TextStyle(color: _muted),
                      ),
                    ),
                  ),
                  Semantics(
                    label: 'benchmark-audio-next',
                    button: true,
                    enabled: _audioPagerIndex < _audioChunks.length - 1,
                    child: OutlinedButton(
                      onPressed: _audioPagerIndex < _audioChunks.length - 1
                          ? () => setState(() => _audioPagerIndex += 1)
                          : null,
                      child: const Text('Next'),
                    ),
                  ),
                ],
              ),
              Semantics(
                label: 'benchmark-audio-current',
                value: currentChunk.value,
                child: const SizedBox(height: 1, width: 1),
              ),
            ],
            const SizedBox(height: 18),
            Semantics(
              label: 'benchmark-json-visible',
              value: _reportJson,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: Colors.white,
                  border: Border.all(color: _line),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: SelectableText(
                    _reportJson.isEmpty ? '{}' : _reportJson,
                    style: const TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: _foreground,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ResultSummary extends StatelessWidget {
  const _ResultSummary({required this.report});

  final Map<String, Object?>? report;

  @override
  Widget build(BuildContext context) {
    final rows = (report?['rows'] as List?)?.cast<Map>() ?? const <Map>[];
    return DecoratedBox(
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: _line),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Models',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
            ),
            const SizedBox(height: 8),
            for (final row in rows)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Text(
                  '${row['modelDisplayName'] ?? row['model']}: ${row['status']}',
                  style: const TextStyle(color: _foreground),
                ),
              ),
            if (rows.isEmpty)
              const Text(
                'No benchmark rows yet.',
                style: TextStyle(color: _muted),
              ),
          ],
        ),
      ),
    );
  }
}

class _TimedGeneration {
  const _TimedGeneration({required this.result, required this.generationMs});

  final KittenTTSResult result;
  final int generationMs;

  double get duration => max(result.duration, 0.001);
}

class _BenchmarkPhonemizerData {
  const _BenchmarkPhonemizerData({
    required this.rulesText,
    required this.listText,
  });

  final String rulesText;
  final String listText;
}

class _AudioChunk {
  const _AudioChunk({
    required this.key,
    required this.accessibilityId,
    required this.value,
  });

  final String key;
  final String accessibilityId;
  final String value;
}

Future<_BenchmarkPhonemizerData> _loadBenchmarkPhonemizerData() async {
  final results = await Future.wait([
    rootBundle.loadString('assets/cephonemizer/en_rules'),
    rootBundle.loadString('assets/cephonemizer/en_list'),
  ]);
  return _BenchmarkPhonemizerData(rulesText: results[0], listText: results[1]);
}

double _percentile(List<num> values, double percentile) {
  if (values.isEmpty) return 0;
  final sorted = values.map((value) => value.toDouble()).toList()..sort();
  final position = (sorted.length - 1) * percentile;
  final lower = position.floor();
  final upper = position.ceil();
  if (lower == upper) return sorted[lower];
  final weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

double _round(num value, [int digits = 3]) {
  final factor = pow(10, digits).toDouble();
  return (value * factor).round() / factor;
}

String _hashBytes(Uint8List bytes) {
  var hash = 0x811c9dc5;
  for (final byte in bytes) {
    hash ^= byte;
    hash = (hash * 0x01000193) & 0xffffffff;
  }
  return hash.toRadixString(16).padLeft(8, '0').substring(0, 8);
}

String _slugify(String value) {
  return value
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
      .replaceAll(RegExp(r'^-+|-+$'), '');
}
