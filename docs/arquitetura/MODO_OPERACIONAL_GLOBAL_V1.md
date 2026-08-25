# Modo Operacional Global V1 — Sprint 05.38.B

## Decisão arquitetural

Toda instalação CDS possui **um** modo operacional global explícito, configurado pelo administrador:

| Valor | Significado |
|-------|-------------|
| `EMPRESA_SIMPLES` | Uma única empresa operacional; fluxo tradicional; sem MUV/seleção |
| `MULTIEMPRESA` | Múltiplas empresas/CNPJs; estoque, vendas e fiscal por empresa |

A decisão **não** pode depender de:

- `empresas.length`
- quantidade de CNPJs
- existência de `estoque_empresa`
- heurísticas automáticas

## Fonte única oficial

```
backend/core/modo-operacional/
├── contratos.js              # valores, validação, capacidades
├── modoOperacionalGlobal.js  # obter / resolver / validar
├── compatibilidadeModoVenda.js
├── PoliticaEmpresaSimples.js
├── PoliticaMultiempresa.js
├── ContratoOperacionalService.js
└── index.js
```

Persistência: `configuracoes.json` via `configuracaoService.js`

Chaves:

- `modo_operacional_global` — fonte principal (`EMPRESA_SIMPLES` | `MULTIEMPRESA`)
- `empresa_operacional_id` — vínculo explícito da empresa única (modo EMPRESA_SIMPLES)
- `modo_operacao_venda` — **compatibilidade MUV** (`EMPRESA_UNICA` | `MULTIEMPRESA`), sincronizado automaticamente

APIs públicas:

```javascript
obterModoOperacionalGlobal(cfg?)
resolverModoOperacionalGlobalAtivo(opcoes?)
validarModoOperacionalGlobal(valor)
```

## Compatibilidade com `modo_operacao_venda`

| Global | Legado MUV |
|--------|------------|
| `EMPRESA_SIMPLES` | `EMPRESA_UNICA` |
| `MULTIEMPRESA` | `MULTIEMPRESA` |

`modoOperacaoVenda.resolverModoOperacaoVendaAtivo()` deriva do modo global quando não há injeção de teste.

**Não alterados nesta sprint:** MUV, AtendimentoMultiempresaService, MaterializarOperacoesAtendimento, FiscalizarAtendimentoService, checkout.

## EMPRESA_SIMPLES — política operacional

`PoliticaEmpresaSimples.resolverEmpresaOperacional()`:

1. Se `empresa_operacional_id` configurado → valida empresa ativa
2. Se exatamente **uma** empresa ativa → resolve deterministicamente
3. Se zero empresas → erro `EMPRESA_OPERACIONAL_AUSENTE`
4. Se N>1 sem vínculo explícito → erro `EMPRESA_OPERACIONAL_AMBIGUA`

**Proibido:** pegar a primeira empresa do banco silenciosamente.

Capacidades:

```javascript
{ multiempresa: false, selecao_empresa: false, muv: false, consolidacao: false }
```

## MULTIEMPRESA — política operacional

Reutiliza integralmente:

- `empresas`, `usuario_empresas`, `empresaContexto.js`
- `X-Empresa-Id`, `estoque_empresa`, MUV, fiscal por empresa

Capacidades:

```javascript
{ multiempresa: true, selecao_empresa: true, muv: true, consolidacao: true }
```

## Contrato operacional único

```javascript
{
  modo_operacional: 'EMPRESA_SIMPLES' | 'MULTIEMPRESA',
  modo_operacao_venda: 'EMPRESA_UNICA' | 'MULTIEMPRESA',
  empresa_operacional: { empresa_id, cnpj, razao_social } | null,
  capacidades: { multiempresa, selecao_empresa, muv, consolidacao }
}
```

Endpoints:

- `GET /api/configuracoes-avancadas/contrato-operacional`
- `GET /api/pdv-universal/contexto` (campos `modo_operacional_global`, `contrato_operacional`)

## Configurações Avançadas

UI: Centro de Configurações → Empresa → **Modo Operacional da Instalação**

Alteração de modo exige:

- confirmação no frontend (`confirm()`)
- `confirmacao_modo_operacional: true` no POST de configurações

Sem migração automática de dados nesta sprint.

## Propagação futura (fora do escopo 05.38.B)

Módulos que **devem** consumir o resolver central nas próximas sprints:

- Caixa (`caixa_sessoes`)
- Financeiro / contas a receber
- Central de Entradas (orquestração multi-CNPJ)
- Dashboard e relatórios

## Bootstrap e migração

Instalações existentes:

- Ausência de `modo_operacional_global` → derivado de `modo_operacao_venda` legado válido
- `MULTIEMPRESA` legado → `MULTIEMPRESA` global
- Demais → `EMPRESA_SIMPLES`
- `modo_operacao_venda` sincronizado após bootstrap

Novas instalações: default `EMPRESA_SIMPLES`.
