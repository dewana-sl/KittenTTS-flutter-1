import 'dart:io';

import 'package:flutter/services.dart';
import 'package:kittentts_flutter/kittentts_flutter.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

Future<KittenTTSModelFiles> resolveBenchmarkModelFiles(
  KittenTTSModelId modelId,
) async {
  final repo = modelRepoId(modelId);
  final supportDir = await getApplicationSupportDirectory();
  final modelDir = Directory(
    p.join(supportDir.path, 'KittenTTSBenchmark', 'models', repo),
  );
  await modelDir.create(recursive: true);

  final onnxPath = p.join(modelDir.path, onnxFileName(modelId));
  final voicesPath = p.join(modelDir.path, voicesFileName(modelId));
  await Future.wait([
    _copyAssetIfNeeded(
      'assets/models/$repo/${onnxFileName(modelId)}',
      onnxPath,
    ),
    _copyAssetIfNeeded(
      'assets/models/$repo/${voicesFileName(modelId)}',
      voicesPath,
    ),
  ]);

  return KittenTTSModelFiles(onnxPath: onnxPath, voicesPath: voicesPath);
}

Future<void> _copyAssetIfNeeded(String assetPath, String outputPath) async {
  final data = await rootBundle.load(assetPath);
  final bytes = data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  final file = File(outputPath);
  if (await file.exists() && await file.length() == bytes.length) return;
  await file.writeAsBytes(bytes, flush: true);
}
