# MOAFIT

여러 스토어의 옷을 한곳에 모아, 내 사이즈와 취향 순으로 보여주는 개인 셀렉트샵 웹앱입니다.

- **앱**: `index.html` 한 파일 (설치형 웹앱, 서버 없음)
- **상품 데이터**: GitHub Actions가 하루 두 번(한국시간 06:17, 18:17) `scripts/fetch.mjs`로 수집해서 `gh-pages` 브랜치에 배포
- **개인 데이터**: 찜·옷장·코디·취향은 쓰는 기기의 브라우저에만 저장 (MY 탭에서 파일로 백업)

## 스토어 추가하기

`config/stores.json`의 `stores`에 한 줄을 추가하면 다음 수집부터 반영됩니다.

```json
{ "id": "my-store", "name": "스토어 이름", "domain": "example.com", "currency": "KRW", "region": "KR" }
```

상품 목록을 `/products.json`으로 공개하는(Shopify 기반) 스토어만 수집할 수 있습니다.
`robots.txt`가 수집을 허용하지 않는 스토어는 자동으로 건너뛰고, 사진은 복사하지 않고 스토어 주소를 그대로 씁니다.
수집 결과는 앱의 MY 탭 → 수집 현황에서 볼 수 있습니다.

## 지금 바로 다시 수집하기

저장소의 Actions 탭 → `catalog` → Run workflow.
