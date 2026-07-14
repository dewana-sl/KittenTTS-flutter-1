// This is a basic Flutter widget test.
//
// To perform an interaction with a widget in your test, use the WidgetTester
// utility in the flutter_test package. For example, you can send tap and scroll
// gestures. You can also use WidgetTester to find child widgets in the widget
// tree, read text, and verify that the values of widget properties are correct.

import 'package:flutter_test/flutter_test.dart';

import 'package:kittentts_flutter_benchmark_app/main.dart';

void main() {
  testWidgets('benchmark app renders', (WidgetTester tester) async {
    await tester.pumpWidget(const KittenBenchmarkApp());

    expect(find.text('KittenTTS Flutter Benchmark'), findsOneWidget);
    expect(find.text('Run benchmark'), findsOneWidget);
  });
}
