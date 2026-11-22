# Release Certification Report — RC4.32.0

## Ambiente

- Versão: 1.0.3
- Commit: 222e90f
- Build: 2026-11-19T18:25:34.435Z
- Hash app.asar: `a447c9340fcad90dce75e4b881079a5bf9fc489dbf8f42a5e3c44e2ad244fda1`
- Origem: fonte
- Data: 2026-11-22T14:20:55.635Z

## Resultados

✔ Inicialização do ERP
  - DB ok | pacote: fonte | asar: N/A…
✔ Login
  - user=rc4320_1795357254494 perfil=SUPER_ADMIN
✔ Cadastro de Produtos
  - CRUD ok | embalagem CX×12 | codigo=RC4320-1795357251512-P
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
  - 4.1s | mem 24.3MB | sql=16

## Estatísticas

- Tempo total: 4.1s
- Memória máxima: 24.3 MB
- CPU user: 1687 ms
- Testes/etapas: 12
- Exceções: 0
- Consultas SQL: 16
- Cobertura funcional: 100%

## Status da Release

**APROVADA**
