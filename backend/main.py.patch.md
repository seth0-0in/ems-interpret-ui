# `/app/backend/open_webui/main.py` 패치

기존 main.py 안에서 다른 router를 `app.include_router(...)` 하고 있는 블록 근처에
아래 두 줄만 추가합니다. **다른 라인은 절대 건드리지 마세요.**

```python
# === 119 실시간 통번역 전용 라우터 (별도 prefix /api/119/realtime) ===
# OWI 핵심 API와 분리해 운영 중에도 안전하게 끄고 켤 수 있도록 try/except로 감싼다.
try:
    from open_webui.routers import ems_realtime as ems_realtime_router
    app.include_router(ems_realtime_router.router)
except Exception as _ems_e:
    import logging as _logging
    _logging.getLogger("ems_realtime").exception(
        "ems_realtime router import failed — 119 realtime endpoint disabled: %s",
        _ems_e,
    )
```

이 블록은:

1. import 실패해도 OWI 전체가 죽지 않도록 try/except로 감쌌습니다.
2. router 자체가 이미 prefix `/api/119/realtime`을 들고 있으므로 여기서 prefix를
   다시 지정하지 않습니다.
3. tags(`ems-realtime`)도 router에 이미 들어 있어 Swagger UI(`/docs`)에서 별도
   섹션으로 보입니다.

## 적용 위치 찾기

대부분의 OWI 버전에서 `main.py` 끝부분 또는 router include 모음 부분에 비슷한 패턴이
있습니다. 예시:

```python
app.include_router(audio.router, prefix="/api/v1/audio", tags=["audio"])
app.include_router(images.router, prefix="/api/v1/images", tags=["images"])
# ... 다른 라우터들 ...

# 👇 여기 또는 마지막 include 바로 아래에 추가
```
