import 'dart:async';
import 'dart:isolate';
import 'dart:math';

import 'package:flutter/services.dart';
import 'package:kittentts_flutter/kittentts_flutter.dart';

Future<Map<String, Object?>> runLowSpecBenchmarkInWorker({
  required RootIsolateToken? rootIsolateToken,
  required String sampleText,
  required String startedAtIso,
  required List<KittenTTSModelId> modelIds,
  required Map<String, Map<String, String>> modelFilesById,
  required int warmRunCount,
  required int ortNumThreads,
  required int maxTokensPerChunk,
  required KittenTTSVoiceId voice,
  required double speed,
  required String phonemizerRulesText,
  required String phonemizerListText,
  required int audioChunkSize,
}) {
  final request = <String, Object?>{
    'sampleText': sampleText,
    'startedAtIso': startedAtIso,
    'modelIds': modelIds,
    'modelFilesById': modelFilesById,
    'warmRunCount': warmRunCount,
    'ortNumThreads': ortNumThreads,
    'maxTokensPerChunk': maxTokensPerChunk,
    'voice': voice,
    'speed': speed,
    'phonemizerRulesText': phonemizerRulesText,
    'phonemizerListText': phonemizerListText,
    'audioChunkSize': audioChunkSize,
  };

  return Isolate.run(() async {
    final token = rootIsolateToken;
    if (token != null) {
      BackgroundIsolateBinaryMessenger.ensureInitialized(token);
    }
    return _runWorkerBenchmark(request);
  });
}

Future<Map<String, Object?>> _runWorkerBenchmark(
  Map<String, Object?> request,
) async {
  final sampleText = request['sampleText'] as String;
  final startedAt = DateTime.parse(request['startedAtIso'] as String);
  final modelIds = (request['modelIds'] as List).cast<KittenTTSModelId>();
  final modelFilesById = (request['modelFilesById'] as Map).map(
    (key, value) =>
        MapEntry(key as String, (value as Map).cast<String, String>()),
  );
  final warmRunCount = request['warmRunCount'] as int;
  final ortNumThreads = request['ortNumThreads'] as int;
  final maxTokensPerChunk = request['maxTokensPerChunk'] as int;
  final voice = request['voice'] as KittenTTSVoiceId;
  final speed = request['speed'] as double;
  final phonemizerRulesText = request['phonemizerRulesText'] as String;
  final phonemizerListText = request['phonemizerListText'] as String;
  final audioChunkSize = request['audioChunkSize'] as int;
  final rows = <Map<String, Object?>>[];
  final audioChunks = <Map<String, Object?>>[];

  for (final modelId in modelIds) {
    final modelName = modelRepoId(modelId);
    final modelFiles = modelFilesById[modelId];
    KittenTTS? tts;

    try {
      if (modelFiles == null) {
        throw StateError(
          'Missing bundled files for ${modelDisplayName(modelId)}.',
        );
      }

      final loadStarted = Stopwatch()..start();
      tts = await KittenTTS.create(
        config: KittenTTSConfig(
          model: modelId,
          analytics: false,
          ortNumThreads: ortNumThreads,
          ortProviders: null,
          maxTokensPerChunk: maxTokensPerChunk,
          modelFiles: KittenTTSModelFiles(
            onnxPath: modelFiles['onnxPath']!,
            voicesPath: modelFiles['voicesPath']!,
          ),
          phonemizer: CEPhonemizer(
            rulesText: phonemizerRulesText,
            listText: phonemizerListText,
          ),
        ),
      );
      loadStarted.stop();

      final first = await _timedGenerate(tts, sampleText, voice, speed);
      final warm = <_TimedGeneration>[];
      for (var index = 0; index < warmRunCount; index += 1) {
        warm.add(await _timedGenerate(tts, sampleText, voice, speed));
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
      final rowChunks = _splitAudio(
        _slugify(modelName),
        wavBase64,
        audioChunkSize,
      );
      audioChunks.addAll(rowChunks);

      rows.add({
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
        'warmRunCount': warmRunCount,
        'warmGenerationMs': warmMs,
        'warmGenerationSeconds': warmSeconds,
        'warmP50GenerationMs': _percentile(warmMs, 0.50).round(),
        'warmP50GenerationSeconds': _round(_percentile(warmMs, 0.50) / 1000),
        'warmP95GenerationMs': _percentile(warmMs, 0.95).round(),
        'warmP95GenerationSeconds': _round(_percentile(warmMs, 0.95) / 1000),
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
      rows.add({
        'model': modelName,
        'modelId': modelId,
        'modelDisplayName': modelDisplayName(modelId),
        'status': 'failed',
        'failedStage': 'Background benchmark ${modelDisplayName(modelId)}',
        'errorSummary': _friendlyError(error),
        'errorDetails': stackTrace.toString().split('\n').take(8).join('\n'),
      });
    } finally {
      await tts?.dispose();
    }
  }

  final finishedAt = DateTime.now().toUtc();
  final failed = rows.any((row) => row['status'] == 'failed');
  final report = <String, Object?>{
    'schemaVersion': 1,
    'status': failed ? 'partial' : 'passed',
    'sampleText': sampleText,
    'characterLength': sampleText.length,
    'voice': voice,
    'voiceDisplayName': voiceDisplayName(voice),
    'speed': speed,
    'warmRunCount': warmRunCount,
    'ortNumThreads': ortNumThreads,
    'ortProviders': null,
    'maxTokensPerChunk': maxTokensPerChunk,
    'startedAt': startedAt.toIso8601String(),
    'finishedAt': finishedAt.toIso8601String(),
    'rows': rows,
  };

  return {'report': report, 'audioChunks': audioChunks};
}

Future<_TimedGeneration> _timedGenerate(
  KittenTTS tts,
  String text,
  KittenTTSVoiceId voice,
  double speed,
) async {
  final timer = Stopwatch()..start();
  final result = await tts.generate(text, voice: voice, speed: speed);
  timer.stop();
  return _TimedGeneration(
    result: result,
    generationMs: max(1, timer.elapsedMilliseconds),
  );
}

List<Map<String, Object?>> _splitAudio(
  String rowSlug,
  String wavBase64,
  int audioChunkSize,
) {
  final chunks = <Map<String, Object?>>[];
  for (var offset = 0; offset < wavBase64.length; offset += audioChunkSize) {
    final index = chunks.length;
    chunks.add({
      'key': '$rowSlug-$index',
      'accessibilityId': 'benchmark-audio-$rowSlug-$index',
      'value': wavBase64.substring(
        offset,
        min(offset + audioChunkSize, wavBase64.length),
      ),
    });
  }
  return chunks;
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
      .replaceAll(RegExp(r'^-|-$'), '');
}

String _friendlyError(Object error) {
  final message = error.toString();
  if (message.length <= 500) return message;
  return '${message.substring(0, 500)}...';
}

class _TimedGeneration {
  const _TimedGeneration({required this.result, required this.generationMs});

  final KittenTTSResult result;
  final int generationMs;

  double get duration => max(result.duration, 0.001);
}
