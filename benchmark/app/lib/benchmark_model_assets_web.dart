import 'package:kittentts_flutter/kittentts_flutter.dart';

Future<KittenTTSModelFiles> resolveBenchmarkModelFiles(
  KittenTTSModelId modelId,
) async {
  final repo = modelRepoId(modelId);
  final assetBase = 'assets/assets/models/$repo';
  return KittenTTSModelFiles(
    onnxPath: '$assetBase/${onnxFileName(modelId)}',
    voicesPath: '$assetBase/${voicesFileName(modelId)}',
  );
}
