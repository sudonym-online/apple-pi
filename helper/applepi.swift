import AVFAudio
import Foundation
import FoundationModels
import Speech
import Translation

// ---- IO ----

setvbuf(stdout, nil, _IOLBF, 0)

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("applepi: \(msg)\n".utf8))
    exit(1)
}

func stdinText() -> String {
    String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
}

// ---- CLASSIFY ----

let classifyInstructions = """
    You route requests for a coding assistant. Decide if answering needs careful multi-step reasoning.
    think: system design, hard debugging, algorithms, concurrency, math or proofs, tradeoff analysis, multi-file refactors.
    no_think: lookups, explanations of one command or flag, small edits, running commands, greetings, short factual questions.
    """

let routeSchema = #"{"type":"object","title":"Route","properties":{"route":{"type":"string","enum":["think","no_think"]}},"required":["route"],"additionalProperties":false}"#

func classify() async {
    let prompt = String(stdinText().prefix(4000))
    guard !prompt.isEmpty else { fail("empty prompt") }
    do {
        let schema = try JSONDecoder().decode(GenerationSchema.self, from: Data(routeSchema.utf8))
        let model = SystemLanguageModel(useCase: .general, guardrails: .permissiveContentTransformations)
        let session = LanguageModelSession(model: model, instructions: classifyInstructions)
        let r = try await session.respond(to: "Request:\n\(prompt)", schema: schema,
                                          options: GenerationOptions(samplingMode: .greedy))
        print(try r.content.value(String.self, forProperty: "route"))
    } catch { fail("\(error)") }
}

// ---- TRANSCRIBE ----

func transcribe(_ path: String, _ locale: String) async {
    do {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        let transcriber = SpeechTranscriber(locale: Locale(identifier: locale), preset: .transcription)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let collect = Task {
            var out = ""
            for try await r in transcriber.results { out += String(r.text.characters) }
            return out
        }
        if let end = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: end)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        print(try await collect.value.trimmingCharacters(in: .whitespacesAndNewlines))
    } catch { fail("\(error)") }
}

// ---- TRANSLATE ----

func translate(_ from: String, _ to: String) async {
    let text = stdinText()
    guard !text.isEmpty else { fail("empty text") }
    do {
        let session = TranslationSession(installedSource: Locale.Language(identifier: from),
                                         target: Locale.Language(identifier: to))
        print(try await session.translate(text).targetText)
    } catch { fail("\(error) (only installed language pairs work)") }
}

// ---- MAIN ----

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "classify": await classify()
case "transcribe" where args.count >= 2: await transcribe(args[1], args.count > 2 ? args[2] : "en-US")
case "translate" where args.count == 3: await translate(args[1], args[2])
default: fail("usage: applepi classify < prompt | transcribe <file> [locale] | translate <from> <to> < text")
}
