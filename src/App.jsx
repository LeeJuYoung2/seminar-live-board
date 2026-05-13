import { useEffect, useMemo, useRef, useState } from "react";
import { initializeApp } from "firebase/app";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";

/*
  세미나 라이브 기록판 - 프로토타입

  목적
  - 진행자 휴대폰: 음성을 텍스트로 변환해 발언 기록에 추가
  - 조원 기기: 같은 방의 발언 기록을 읽기 전용으로 확인
  - 현재 프로토타입은 localStorage 기반입니다.
  - 여러 기기 실시간 공유를 하려면 아래 STORAGE_MODE를 "firebase"로 바꾸고 Firebase 코드를 연결하면 됩니다.

  주의
  - Web Speech API는 Chrome/Edge 계열 브라우저에서 가장 잘 작동합니다.
  - iPhone Safari에서는 음성 인식이 제한될 수 있습니다.
*/

const STORAGE_MODE = "firebase"; // "local" 또는 "firebase"

const firebaseConfig = {
  apiKey: "AIzaSyBttJh3Rd95-3i19ec9Q66I221Zesz9HTY",
  authDomain: "socratic-seminar-tool.firebaseapp.com",
  projectId: "socratic-seminar-tool",
  storageBucket: "socratic-seminar-tool.firebasestorage.app",
  messagingSenderId: "906770342229",
  appId: "1:906770342229:web:2e4a02e08acadbb1bb0fdc",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const DEFAULT_ROOM = "1조";

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getRoomKey(roomName) {
  return `socratic-seminar-transcripts:${roomName}`;
}

function readLocalRecords(roomName) {
  try {
    const raw = localStorage.getItem(getRoomKey(roomName));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeLocalRecords(roomName, records) {
  localStorage.setItem(getRoomKey(roomName), JSON.stringify(records));
}

export default function SocraticSeminarLiveTranscriptPrototype() {
  const [roomName, setRoomName] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("room") || DEFAULT_ROOM;
  });
  const [mode, setMode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const urlMode = params.get("mode");
    return urlMode === "viewer" || urlMode === "host" ? urlMode : "host";
  }); // host | viewer
  const [records, setRecords] = useState([]);
  const [listening, setListening] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showQrWindow, setShowQrWindow] = useState(false);

  const recognitionRef = useRef(null);
  const bottomRef = useRef(null);

  const isSpeechSupported = useMemo(() => {
    return typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
  }, []);

  useEffect(() => {
    if (STORAGE_MODE === "local") {
      return;
    }

    const recordsRef = collection(db, "rooms", roomName, "records");
    const recordsQuery = query(recordsRef, orderBy("createdAt", "asc"));

    const unsubscribe = onSnapshot(recordsQuery, (snapshot) => {
      const nextRecords = snapshot.docs.map((docItem) => ({
        firebaseId: docItem.id,
        ...docItem.data(),
      }));

      setRecords(nextRecords);
    });

    return () => unsubscribe();
  }, [roomName]);

  useEffect(() => {
    if (STORAGE_MODE === "local") {
      writeLocalRecords(roomName, records);
    }
  }, [records, roomName]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [records, liveText]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === getRoomKey(roomName) && event.newValue) {
        try {
          setRecords(JSON.parse(event.newValue));
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [roomName]);

  async function addRecord(text) {
    const cleanText = text.trim();
    if (!cleanText) return;

    const nextRecord = {
      id: makeId(),
      text: cleanText,
      time: formatTime(),
      createdAt: Date.now(),
    };

    if (STORAGE_MODE === "local") {
      setRecords((prev) => [...prev, nextRecord]);
      return;
    }

    await addDoc(collection(db, "rooms", roomName, "records"), nextRecord);
  }

  function getSpeechErrorMessage(errorCode) {
    const messages = {
      "not-allowed": "마이크 권한이 차단되었습니다. 브라우저 주소창 왼쪽의 권한 설정에서 마이크를 허용해 주세요.",
      "service-not-allowed": "현재 실행 환경에서 음성 인식 서비스 사용이 차단되었습니다. Chrome 또는 Edge에서 https 주소로 실행해 주세요.",
      "no-speech": "음성이 감지되지 않았습니다. 조금 더 가까이에서 말한 뒤 다시 시도해 주세요.",
      "audio-capture": "마이크를 찾을 수 없습니다. 기기의 마이크 연결과 브라우저 권한을 확인해 주세요.",
      "network": "음성 인식 네트워크 오류입니다. 인터넷 연결 상태를 확인해 주세요.",
      "aborted": "음성 인식이 중단되었습니다. 다시 기록 시작을 눌러 주세요.",
    };

    return messages[errorCode] || `음성 인식 오류: ${errorCode}`;
  }

  function startListening() {
    setError("");

    if (!isSpeechSupported) {
      setError("현재 브라우저에서는 음성 인식이 지원되지 않습니다. Chrome 또는 Edge에서 실행해 주세요. Netlify 같은 https 배포 주소에서 다시 실행해 주세요.");
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();

    recognition.lang = "ko-KR";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setListening(true);
      setLiveText("");
    };

    recognition.onresult = (event) => {
      let interim = "";
      let finalText = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript;
        } else {
          interim += transcript;
        }
      }

      if (interim) setLiveText(interim);
      if (finalText) {
        addRecord(finalText);
        setLiveText("");
      }
    };

    recognition.onerror = (event) => {
      setError(getSpeechErrorMessage(event.error));
      setListening(false);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
  }


  async function clearRecords() {
    const ok = window.confirm("현재 방의 발언 기록을 모두 삭제할까요?");
    if (!ok) return;

    if (STORAGE_MODE === "local") {
      setRecords([]);
      setLiveText("");
      return;
    }

    const snapshot = await getDocs(collection(db, "rooms", roomName, "records"));

    await Promise.all(
      snapshot.docs.map((docItem) =>
        deleteDoc(doc(db, "rooms", roomName, "records", docItem.id))
      )
    );

    setLiveText("");
  }

  function getViewerUrl() {
    return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(roomName)}&mode=viewer`;
  }

  function getQrUrl() {
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(getViewerUrl())}`;
  }

  async function copyViewerLink() {
    const url = getViewerUrl();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("링크 복사에 실패했습니다. 주소창의 URL을 직접 복사해 주세요.");
    }
  }


  function refreshRecords() {
    setRecords(readLocalRecords(roomName));
  }

  if (showQrWindow) {
    return (
      <div className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100">
        <div className="mx-auto flex min-h-[calc(100vh-48px)] max-w-3xl flex-col items-center justify-center rounded-3xl border border-slate-800 bg-slate-900 p-6 text-center shadow-2xl shadow-black/30">
          <p className="mb-3 text-base font-semibold text-cyan-300">Socratic Seminar Tool</p>
          <h1 className="text-3xl font-black tracking-tight sm:text-5xl">{roomName} 접속 QR코드</h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-slate-400 sm:text-lg">
            조원은 휴대폰 카메라로 QR코드를 찍고 들어오면 발언 기록을 읽기 전용으로 볼 수 있습니다.
          </p>

          <div className="my-8 rounded-[2rem] bg-white p-5 shadow-xl shadow-black/30">
            <img src={getQrUrl()} alt="조원용 접속 QR코드" className="h-[260px] w-[260px] sm:h-[340px] sm:w-[340px]" />
          </div>

          <p className="mb-6 max-w-2xl break-all rounded-2xl bg-slate-950 px-4 py-3 text-sm leading-6 text-slate-400">{getViewerUrl()}</p>

          <div className="flex flex-wrap justify-center gap-3">
            <button
              onClick={copyViewerLink}
              className="rounded-2xl bg-cyan-400 px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-300"
            >
              링크 복사
            </button>
            <button
              onClick={() => setShowQrWindow(false)}
              className="rounded-2xl bg-slate-800 px-5 py-3 text-sm font-bold text-slate-200 transition hover:bg-slate-700"
            >
              진행자 화면으로 돌아가기
            </button>
          </div>

          {copied && <p className="mt-4 text-sm font-semibold text-cyan-300">링크가 복사되었습니다.</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="mb-5 rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-2xl shadow-black/20">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="mb-1 text-sm font-medium text-cyan-300">Socratic Seminar Tool</p>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">세미나 라이브 기록판</h1>
              <p className="mt-2 text-sm text-slate-400">진행자 휴대폰에서 나온 발언을 조원들이 읽기 전용으로 확인하는 프로토타입입니다.</p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setMode("host")}
                className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold transition ${
                  mode === "host" ? "bg-cyan-400 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                <span>👑</span> 진행자
              </button>
              <button
                onClick={() => setMode("viewer")}
                className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold transition ${
                  mode === "viewer" ? "bg-cyan-400 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                <span>👀</span> 보기 전용
              </button>
            </div>
          </div>
        </header>

        <main className="grid flex-1 gap-5 lg:grid-cols-[320px_1fr]">
          <section className="rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl shadow-black/10">
            <label className="mb-2 block text-sm font-semibold text-slate-300">방 이름</label>
            <input
              value={roomName}
              onChange={(event) => setRoomName(event.target.value || DEFAULT_ROOM)}
              className="mb-4 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-base text-slate-100 outline-none focus:border-cyan-400"
              placeholder="예: 1조"
            />

            <div className="mb-4 rounded-2xl bg-slate-950 p-4">
              <p className="text-sm text-slate-400">현재 모드</p>
              <p className="mt-1 text-lg font-bold">{mode === "host" ? "진행자 화면" : "조원 보기 화면"}</p>
            </div>

            {mode === "host" ? (
              <div className="space-y-3">
                {!listening ? (
                  <button
                    onClick={startListening}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-cyan-400 px-4 py-3 font-bold text-slate-950 transition hover:bg-cyan-300"
                  >
                    <span>🎙️</span> 기록 시작
                  </button>
                ) : (
                  <button
                    onClick={stopListening}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-rose-400 px-4 py-3 font-bold text-slate-950 transition hover:bg-rose-300"
                  >
                    <span>⏸️</span> 일시정지
                  </button>
                )}

                <button
                  onClick={clearRecords}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-800 px-4 py-3 font-semibold text-slate-200 transition hover:bg-slate-700"
                >
                  <span>🗑️</span> 기록 초기화
                </button>

                <button
                  onClick={() => setShowQrWindow(true)}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-800 px-4 py-3 font-semibold text-slate-200 transition hover:bg-slate-700"
                >
                  <span>📱</span> QR 안내 창 열기
                </button>

                <button
                  onClick={copyViewerLink}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-800 px-4 py-3 font-semibold text-slate-200 transition hover:bg-slate-700"
                >
                  <span>🔗</span> 조원용 링크 복사
                </button>

                {copied && <p className="text-center text-sm font-semibold text-cyan-300">링크가 복사되었습니다.</p>}
              </div>
            ) : (
              <div className="space-y-3">
                <button
                  onClick={refreshRecords}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-800 px-4 py-3 font-semibold text-slate-200 transition hover:bg-slate-700"
                >
                  <span>🔄</span> 기록 새로고침
                </button>
                <div className="rounded-2xl bg-slate-950 p-4 text-sm leading-6 text-slate-400">
                  이 화면은 읽기 전용입니다. 조원은 이곳에서 질문자의 발언을 확인하고, 메모는 종이에 따로 작성하면 됩니다.
                </div>
              </div>
            )}

            {error && (
              <div className="mt-4 flex gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
                <span className="mt-0.5 shrink-0">⚠️</span>
                <p>{error}</p>
              </div>
            )}

            <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950 p-4 text-xs leading-5 text-slate-500">
              <p className="font-semibold text-slate-400">프로토타입 안내</p>
              <p className="mt-1">현재 버전은 같은 브라우저/기기 테스트용 localStorage 방식입니다. 실제 여러 기기 공유는 Firebase 연결 후 사용합니다.</p>
            </div>
          </section>

          <section className="flex min-h-[560px] flex-col rounded-3xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl shadow-black/10">
            <div className="mb-4 flex flex-col gap-2 border-b border-slate-800 pb-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-sm font-medium text-cyan-300">{roomName}</p>
                <h2 className="text-xl font-bold">실시간 발언 기록</h2>
              </div>
              <div className="text-sm text-slate-400">누적 {records.length}개 문장</div>
            </div>

            {mode === "host" && (
              <div className="mb-4 rounded-3xl border border-cyan-400/30 bg-cyan-400/10 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-cyan-200">
                  <span className={`h-2.5 w-2.5 rounded-full ${listening ? "bg-cyan-300" : "bg-slate-600"}`} />
                  {listening ? "현재 듣는 중" : "대기 중"}
                </div>
                <p className="min-h-[48px] text-lg font-medium leading-8 text-slate-100">
                  {liveText || "기록 시작을 누르면 인식 중인 문장이 여기에 표시됩니다."}
                </p>
              </div>
            )}

            <div className="flex-1 overflow-y-auto rounded-3xl bg-slate-950 p-4">
              {records.length === 0 ? (
                <div className="flex h-full min-h-[300px] items-center justify-center text-center text-slate-500">
                  <div>
                    <p className="text-lg font-semibold text-slate-400">아직 기록된 발언이 없습니다.</p>
                    <p className="mt-2 text-sm">진행자 화면에서 기록 시작을 누르고 말하면 여기에 쌓입니다.</p>
                  </div>
                </div>
              ) : (
                <ol className="space-y-3">
                  {records.map((record, index) => (
                    <li key={record.firebaseId || record.id} className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs font-bold text-cyan-300">{index + 1}</span>
                        <span className="text-xs text-slate-500">{record.time}</span>
                      </div>
                      <p className="text-lg leading-8 text-slate-100">{record.text}</p>
                    </li>
                  ))}
                  <div ref={bottomRef} />
                </ol>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
