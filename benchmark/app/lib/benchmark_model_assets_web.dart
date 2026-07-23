import 'package:kittentts_flutter/kittentts_flutter.dart';

Future<KittenTTSModelFiles> resolveBenchmarkModelFiles(
  KittenTTSModelId modelId,
) async {
  final repo = modelRepoId(modelId);
  final onnxAssetBase = 'assets/assets/models/$repo';
  final voicesAssetBase = 'assets/models/$repo';
  return KittenTTSModelFiles(
    onnxPath: '$onnxAssetBase/${onnxFileName(modelId)}',
    voicesPath: 'asset://$voicesAssetBase/${voicesFileName(modelId)}',
  );
}
