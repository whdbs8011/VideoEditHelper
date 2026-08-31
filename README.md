# Premiere Storyboard Builder

스토리보드 CSV 또는 Excel 파일을 검증하고 미디어를 찾아 Adobe Premiere Pro 타임라인에 자동 배치합니다.

- **Premiere 내부 사용(권장):** Premiere Pro **25.6 이상**용 공식 UXP 도킹 패널
- **외부 배치 실행:** Python CLI + 생성된 ExtendScript + Pymiere Link
- Windows와 macOS 지원, Python 경로 처리는 모두 `pathlib.Path` 사용

## CSV 형식

```csv
file_name,start_time,duration,track_index
intro.mp4,0,5,1
shots/scene_01.mov,00:00:05.000,8.5,1
b_roll,00:00:13.500,4,2
outro.mp4,00:00:17.500,,1
```

| 열 | 필수 | 의미 |
|---|---:|---|
| `file_name` | 예 | 확장자 포함/미포함 파일명 또는 미디어 루트 기준 상대 경로 |
| `start_time` | 예 | 초 또는 `HH:MM:SS[.sss]` |
| `duration` | 아니요 | 타임라인에 표시될 클립 길이. 비우면 원본 길이 |
| `track_index` | 아니요 | Premiere UI 기준 비디오 트랙 번호(1부터 시작), 기본값 1 |

확장자 없는 이름의 후보가 여러 개이거나 같은 파일명이 여러 폴더에 있으면 안전을 위해 중단합니다. 이 경우 `shots/scene_01.mov`처럼 상대 경로를 사용하세요.

## 기존 Excel 형식도 바로 사용

`.xlsx`에서 다음 한국어 머리글이 있는 행을 자동으로 찾습니다. 머리글이 1행이 아니어도 되고, Numbers가 분해형 한글로 내보낸 파일도 처리합니다.

| Excel 열 | 변환 결과 |
|---|---|
| `컷 번호` | 확장자 없는 `file_name` (`1`은 `1.mp4`, `1.mov` 등을 탐색) |
| `시작 시간` | Excel 시간 값을 타임라인 초로 변환 |
| `길이(초)` | `duration` |
| `종료 시간` | `길이(초)`가 비었을 때 duration 계산에 사용 |

동시에 겹치는 컷은 낮은 트랙부터 자동으로 V1, V2, V3에 분산됩니다. 표준 `file_name`, `start_time`, `duration`, `track_index` 머리글을 가진 `.xlsx`도 지원합니다. 원본 `.xlsx`를 CSV로 다시 저장할 필요가 없습니다.

## 1. Premiere 내부 UXP 패널 사용(권장)

요구 사항:

- Adobe Premiere Pro 25.6 이상
- Adobe UXP Developer Tool 2.2 이상(개발 중 로드할 때)

macOS에서 저장소 받기:

```bash
git clone https://github.com/whdbs8011/VideoEditHelper.git
cd VideoEditHelper
```

설치/개발 로드:

1. Premiere의 **Settings/Preferences → Plugins → Enable Developer Mode**를 켠 뒤 Premiere를 재시작합니다.
2. UXP Developer Tool에서 **Add Plugin**을 누릅니다.
3. [`uxp_plugin/manifest.json`](./uxp_plugin/manifest.json)을 선택하고 **Load**를 누릅니다.
4. Premiere에서 **Window → UXP Plugins → Storyboard Builder**를 엽니다.
5. CSV 또는 XLSX와 미디어 루트 폴더를 선택한 뒤 **타임라인 생성**을 누릅니다.

패널은 Python, Pymiere, 로컬 서버를 사용하지 않습니다. Premiere 25.6에 도입된 공식 비동기 DOM, undo 가능한 transaction, 권한 기반 파일 선택기만 사용합니다. 배포 시 UXP Developer Tool에서 `.ccx`로 패키징하면 Windows/macOS에서 설치할 수 있습니다.

## 2. Python CLI 사용

Python 3.10 이상을 권장합니다.

### 설치

Windows PowerShell:

```powershell
py -3 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

macOS:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

저장소를 아직 받지 않았다면 먼저 다음을 실행합니다.

```bash
git clone https://github.com/whdbs8011/VideoEditHelper.git
cd VideoEditHelper
```

자동 실행에는 Premiere가 실행 중이어야 하며 **Pymiere Link** CEP 확장이 별도로 설치되어 있어야 합니다. Pymiere 1.4.1은 더 이상 유지보수되지 않으므로, Premiere 내부 사용에는 위 UXP 패널을 권장합니다.

### 실행

```bash
python main.py example_storyboard.csv \
  --media-root "/path/to/media" \
  --project "/path/to/project.prproj" \
  --sequence "Main Sequence"
```

Excel 원본을 직접 쓰는 경우 첫 번째 인자만 바꿉니다.

```bash
python main.py "스토리보드_컷_시간표_.xlsx" \
  --media-root "/path/to/media" \
  --project "/path/to/project.prproj"
```

macOS에서는 `/Users/사용자명/...` 형태의 실제 `.prproj` 및 미디어 경로로 바꿔 실행하세요. 경로에 공백이나 한글이 있으면 위 예시처럼 따옴표로 감싸면 됩니다.

Windows 예시:

```powershell
python main.py .\example_storyboard.csv `
  --media-root "D:\Project\Media" `
  --project "D:\Project\edit.prproj" `
  --sequence "Main Sequence"
```

주요 옵션:

- `--dry-run`: CSV/XLSX 및 미디어 검증과 JSX 생성만 수행
- `--output-jsx PATH`: 생성할 JSX 위치(기본 `storyboard_build.jsx`)
- `--no-audio`: 비디오만 배치
- `--no-save`: 완료 후 프로젝트를 저장하지 않음
- `--bin-name NAME`: 자동 임포트 빈 이름
- `--verbose`: 상세 로그 출력

`--sequence`를 생략하면 Premiere의 활성 시퀀스를 사용합니다. 소스 오디오는 기본적으로 같은 번호의 오디오 트랙에 배치하며, 해당 번호가 없으면 존재하는 가장 높은 오디오 트랙을 사용합니다.

## 테스트

```bash
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

UXP JavaScript 구문은 Node.js가 설치된 개발 환경에서 다음처럼 확인할 수 있습니다.

```bash
node --check uxp_plugin/index.js
```

## 프로젝트 구조

```text
config.py                 데이터 구조와 공통 설정
csv_parser.py             CSV/XLSX 검증, 기존 Excel 변환, 미디어 탐색
premiere_builder.py       ExtendScript 생성과 Pymiere 실행
main.py                   Python CLI 진입점
example_storyboard.csv    예제 CSV
uxp_plugin/               Premiere Pro 25.6+ 인앱 패널
tests/                    Python 단위 테스트
```

## 동작 및 안전 특성

- 파일 경로는 Python에서 절대 경로로 정규화하고, JSX에는 UTF-16 코드 단위 표현으로 삽입해 한글·공백·따옴표·Windows 드라이브 경로를 안전하게 전달합니다.
- 프로젝트에 동일한 실제 미디어 경로가 있으면 재사용하고, 없으면 `Storyboard Media` 빈에 임포트합니다.
- `track_index`가 실제 시퀀스 트랙 범위를 벗어나면 해당 원본 행 번호와 함께 중단합니다.
- UXP의 배치와 길이 변경은 Premiere transaction으로 실행되어 Undo 기록에 남습니다.

패널에 포함된 XLSX 읽기 엔진은 SheetJS Community Edition 0.20.3이며, 라이선스는 `uxp_plugin/vendor/SHEETJS-LICENSE.txt`에 포함되어 있습니다.
