# Contexto fiscal e conexão SQLite na Central MULTIEMPRESA (03.06.1)

## 1. Erro encontrado

```
[empresa 1] db obrigatório para configuração fiscal por empresa
[empresa 2] db obrigatório para configuração fiscal por empresa
[empresa 3] db obrigatório para configuração fiscal por empresa
```

Alvos já resolvidos (empresaId 1, 2, 3). O modo já era MULTIEMPRESA.

## 2. Origem do erro

**Produção (A):** `backend/services/fiscal/empresasConfiguracaoFiscal.js` → `garantirSchemaFiscalEmpresaAsync(db)` linha ~93.

Chamador: `CentralConfiguracaoService.obterContextoOperacional` passava `db: this._db || null`.

`this._db` era `null` porque `CentralConfiguracaoService` / `CentralSincronizacaoService` eram instanciados **sem** a conexão SQLite. Em MULTIEMPRESA `permitirFallbackGlobal` é `false`, então a exceção virava a mensagem acima **por empresa**.

**Não** era ausência de cadastro fiscal: as três empresas já tinham linha em `empresas_configuracao_fiscal` (ambiente 2, certificado presente).

Classificação de ocorrências da string:

| Onde | Classe |
|------|--------|
| `empresasConfiguracaoFiscal.js` | A produção |
| testes desta sprint | B |

Não havia mock C nem docs E com essa frase antes.

## 3. Fonte oficial do `db`

Neste sistema **`db` não é um campo da configuração fiscal nem um SQLite por CNPJ.**

É a **conexão sqlite3 do ERP** usada para ler:

```sql
SELECT * FROM empresas_configuracao_fiscal WHERE empresa_id = ?
```

Arquivo oficial (instalação): `C:\ProgramData\MercantilFiscal\dados\mercadao.db`

A mesma conexão serve A, B e C. O isolamento é o `empresa_id` da linha, não três arquivos.

Loader oficial de certificado/CNPJ/ambiente da empresa: `getFiscalConfig({ empresaId, db })` em `configService.js` (`useDb` / `carregarConfiguracaoFiscalEmpresa`). A Central passou a usar esse loader (não o DTO público, que **não** traz `certificadoPath`).

## 4. Chamadores

- `CentralSincronizacaoService._sincronizarEmpresa` → `obterContextoOperacional({ empresaId, db })`
- `buscarPorChave` (mesmo contrato)
- Orchestrator / `CentralSyncExecucaoService` passam `db: deps.db` ao construir o serviço de configuração

## 5–6. Fluxo empresaId e db

```
listarAlvosSincronizacaoCentral()
  → { empresaId, cnpj }   // sem db no alvo (arquitetura: resolver fiscal por empresaId)
        ↓
_sincronizarEmpresa(alvo)
        ↓
obterContextoOperacional({ empresaId, db })
        ↓
_resolverConexaoSqlite: opcoes.db → this._db → resolverDb (database.js)
        ↓
getFiscalConfig({ empresaId, db })
        ↓
empresas_configuracao_fiscal WHERE empresa_id = ?
        ↓
contexto SEFAZ daquela empresa
```

**Onde o db desaparecia:** entre o alvo (só empresaId) e `obterConfiguracaoFiscalEmpresa(..., { db: null })`.

**Correção:** transportar/resolver a conexão SQLite oficial; carregar fiscal por `empresaId`. Sem segundo catálogo. Sem `empresa_operacional_id`.

## 7–9. Empresas da instalação

| | empresaId | CNPJ (cadastro) | db (conexão) | Config fiscal |
|--|-----------|-----------------|---------------|---------------|
| A | 1 | 38204469000115 | SQLite ERP `mercadao.db` | linha `empresa_id=1` (existente) |
| B | 2 | 38204469000387 | o mesmo arquivo | `empresa_id=2` |
| C | 3 | 38204469000204 | o mesmo arquivo | `empresa_id=3` |

Testes A/B/C usam ids 11/22/33 e **marcadores distintos** (`dbA`/`dbB`/`dbC`) para provar que a iteração não reutiliza o handle da anterior.

## 10. Cross-company

`opcoes.db` da chamada atual prevalece sobre `this._db` de construção. A→B→C→A: dbA, dbB, dbC, dbA.

## 11. Ausência de db / config

Sem linha fiscal: `CONFIGURACAO_FISCAL_EMPRESA_AUSENTE` (não copia A). Sem conexão e sem resolver: erro `db obrigatório...`. Sem inventar banco.

## 12. Fallback proibido

Sem primeiro db, empresa 1, último, COMPAT, COALESCE de dono, `empresa_operacional_id` em MULTIEMPRESA.

`resolverDb(null)` = conexão ERP oficial (já usada pelos repositórios da Central), **não** o db de outra empresa.

## 13–14. Testes e regressões

`tests/central-entradas/contexto-fiscal-db-multiempresa-03-06-1.test.js` T01–T16.

Regressões: 05.54–05.76 e 03.01–03.05 — ver `docs/IMPLEMENTACAO_03_06_1_RELATORIO.md`.

## 15. Riscos

Certificado/arquivo no disco e SEFAZ reais continuam fora desta sprint. Se o processo da Central já estava em memória, recarregar o servidor para pegar o código novo.
