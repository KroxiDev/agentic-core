# Herramientas Python distribuidas

Los wheels conservan las licencias MIT completas dentro de sus directorios `.dist-info`.

| Herramienta | Versión y origen | SHA-256 del wheel |
| --- | --- | --- |
| dry4python | 0.1.0, https://github.com/marandaneto/dry4python/tree/86223d3eda5f3a25f90bced4a3816341bd067137 | 8243ffacbf842bbdf9717df7ff1c8d473bb7f3c30df6c0d3cd925cd651532944 |
| crap4py | 0.1.1, https://pypi.org/project/crap4py/0.1.1/ | 2cdaf28dccfc88313c95f1bacdf99fe19a39efbe9855d981352bb02a7a17a90c |
| mutate4py | 0.1.4, https://pypi.org/project/mutate4py/0.1.4/ | 374e86bf1d99a3a75742f5f333be1ac0128832b23ad5b5680f1e9c2553cc869e |

dry4python se construyó desde el archivo fuente del commit indicado con `python -m pip wheel --no-deps` (setuptools). Los otros wheels son los publicados en PyPI. Ningún motor ha sido modificado. El paquete conserva estos artefactos para instalaciones independientes y sin acceso a la red. Python 3.11 es el mínimo; la instalación comprueba importaciones y CLI con la versión efectiva, sin garantizar toda sintaxis futura.
