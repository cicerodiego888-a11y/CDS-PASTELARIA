# Todas as empresas — inbox da Central (05.79)

## Problema

A opção **Todas as empresas** só mudava o seletor na UI. Lista, dashboard e indicadores continuavam no `X-Empresa-Id` da empresa do contexto. A tabela misturava classes de card/grid (`central-rc40-doc-row`) com `<tr>`/`<td>`, sobrepondo status, valor e ações.

## Contrato

- Empresa específica: `empresa_id = ?` da empresa do contexto (como 05.78).
- Todas as empresas: query `escopo=todas` + `empresa_id IN (ids autorizados do usuário)` e `empresa_id IS NOT NULL`.
- Sem `escopo=todas` + string `'todas'` no repositório: **não** libera SELECT global (`1 = 0`).
- `empresa_id` NULL não entra na consolidação.
- Empresa não autorizada não entra no IN.
- EMPRESA_SIMPLES: “todas” permanece a empresa operacional.
- Um GET; o cliente **não** dispara uma consulta por empresa.
- SEFAZ / saúde do certificado: continuam da empresa do contexto (não misturam certificados).
- Abrir documento de outra autorizada: alinha `X-Empresa-Id` ao `documento.empresa_id` sem sair da vista “todas”, para o detalhe/mutação usarem o dono certo.

## Layout

Linha da lista: `central-0577-doc-row` + `display: table-row`. Colunas Empresa, CNPJ, Tipo, Número, Série, Fornecedor, Emissão, Valor, Status, Ações. Sem grid da UX RC40 na `<tr>`.
