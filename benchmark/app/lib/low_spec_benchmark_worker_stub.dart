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
  throw UnsupportedError('Low-spec benchmark workers require dart:io.');
}
