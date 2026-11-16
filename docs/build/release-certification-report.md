# Release Certification Report — RC4.32.0

## Ambiente

- Versão: 1.0.3
- Commit: 694fb39
- Build: 2026-11-15T23:06:56.540Z
- Hash app.asar: `ab10862ce658ce92de523456835c8dff09c4bdf1d1c3d2a986607f4d48e9420c`
- Origem: instalador-desatualizado
- Data: 2026-11-16T10:37:27.752Z

## Resultados

✔ Inicialização do ERP
  - DB ok | pacote: instalador-desatualizado | asar: ab10862ce658…
✔ Login
  - user=rc4320_1794825446879 perfil=SUPER_ADMIN
✔ Cadastro de Produtos
  - CRUD ok | embalagem CX×12 | codigo=RC4320-1794825442121-P
✔ Compras
  - NF-e …00000064 | status=EM_REVISAO | empresa=1
✔ Financeiro
  - parser financeiro OK | parcela R$500 | registros financeiro=0
✔ Estoque
  - fiscal=6+3 | total=15 UN
✔ MIIP
  - MUC 10×12 → 120 UN (MULTIPLICADOR)
✔ Central Inteligente
  - documento 000064 processado
✔ NFC-e
  - homologação dest.xNome + módulo emissor presente
✔ NF-e
  - autorização cStat=100 | protocolo=123
✔ Relatórios
  - compras=0 fin=0 prod=0
✔ Performance
  - 5.6s | mem 34.9MB | sql=16

## Estatísticas

- Tempo total: 5.6s
- Memória máxima: 34.9 MB
- CPU user: 1907 ms
- Testes/etapas: 12
- Exceções: 0
- Consultas SQL: 16
- Cobertura funcional: 100%

## Status da Release

**APROVADA**
