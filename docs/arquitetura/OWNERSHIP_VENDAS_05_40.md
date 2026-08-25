# OWNERSHIP DE VENDAS — Sprint 05.40

**Status:** implementado  
**Data:** 2026-08-24

## Modelo oficial

A partir desta sprint:

```
venda
  │
  └── empresa_id ───► EMPRESA (CNPJ operacional)
```

`vendas.empresa_id` é o **ownership definitivo** da operação comercial.

Não substitui, mas também não é substituído por:

- `caixa_sessao_id` / `caixa_id`
- usuário autenticado
- empresa do `localStorage` / frontend
- configuração global (`empresa_operacional_id`)
- último caixa aberto
- `atendimento_operacoes` (MUV)

Esses vínculos podem coexistir. A leitura operacional usa **somente** `vendas.empresa_id`.

## Invariante 05.40

Toda **venda nova** deve falhar explicitamente se não houver empresa do contexto:

```
EMPRESA_CONTEXT_REQUIRED
```

Não existe fallback:

- `empresa_id = 1`
- última empresa do banco
- empresa global padrão
- inferência na listagem

A coluna permanece **nullable** no SQLite para preservar legado não classificado.

```
venda nova  → empresa_id NOT NULL (aplicação)
venda legada sem vínculo auditável → empresa_id NULL
```

## Arquitetura fiscal × não fiscal (inalterada)

Uma venda continua sendo **uma única venda**, com:

- `valor_fiscal` / `valor_nao_fiscal`
- `quantidade_fiscal` / `quantidade_nao_fiscal` nos itens

`empresa_id` não duplica a venda nem isola item a item. Itens herdam ownership da venda.

`vendas_itens` **não** recebe `empresa_id` nesta sprint.

## Migration

Arquivo: `backend/utils/vendasEmpresaHelpers.js`  
Gatilho: `database.js` → `inicializarBanco` (após 05.38.C/D/E/F).

1. `ALTER TABLE vendas ADD COLUMN empresa_id INTEGER REFERENCES empresas(id)` (idempotente)
2. `CREATE INDEX IF NOT EXISTS idx_vendas_empresa_id ON vendas(empresa_id)`
3. Backfill **somente** quando determinístico:

| Prioridade | Origem | Condição |
|------------|--------|----------|
| 1 | `caixa_sessoes.empresa_id` | `vendas.caixa_sessao_id` |
| 2 | `atendimento_operacoes.empresa_id` | `venda_id` MUV |
| — | — | restante permanece `NULL` |

Não preenche NULL com empresa operacional / única ativa.

Log:

```
MIGRATION_VENDAS_EMPRESA_05_40
TOTAL: N
CLASSIFICADAS_VIA_CAIXA: N
CLASSIFICADAS_VIA_MUV: N
NÃO_CLASSIFICADAS: N
```

## Regras de criação

Helper central: `VendaEmpresaContextoService`

- `resolverEmpresaIdParaVenda` — SIMPLES = contrato; MULTI = `req.empresaId` / `X-Empresa-Id` (não usa `query.empresa_id`)
- `exigirEmpresaDaOperacao` — invariante de INSERT
- `exigirCaixaCompativelComVenda` — se houver sessão, `caixa.empresa_id` deve ser igual; não altera a empresa

Writers:

| Fluxo | Origem do empresa_id |
|-------|----------------------|
| PDV Express / ERP / Universal EMPRESA_UNICA | contexto resolvido (`req.empresaId`) |
| Entrega | mesmo contexto da operação |
| MUV materialização | `operacao.empresaId` persistido |

## Regras de leitura

Operacional (`GET /api/vendas`, detalhe, relatórios desta rota):

```
WHERE v.empresa_id = ?
```

- Não retorna legado `NULL`
- Consulta por id de outra empresa → **404** (`VENDA_NAO_ENCONTRADA`), sem revelar existência
- Não usa `req.query.empresa_id` como substituto do contexto

Consultas técnicas globais (migration / backfill / diagnóstico) permanecem nos helpers de schema, não em rota pública.

## Legado NULL

Vendas com `empresa_id IS NULL` são **legado não classificado**.

Não entram na listagem da empresa atual.

Saneamento administrativo (ferramenta de classificação) **não** faz parte desta sprint.

## Fora de escopo (próximas sprints)

- Correção completa de cancelamento / devolução
- NFC-e por empresa
- Writers financeiros satélites
- Lotes FEFO / reservas
- DistDFe
