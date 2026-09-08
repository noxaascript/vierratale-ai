from setuptools import setup, find_packages

setup(
    name="vierrataleai",
    version="0.1.0b16",
    description="VierrataleAI - Intelligent terminal assistant",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "rich>=13.0",
    ],
    entry_points={
        "console_scripts": [
            "vierrataleai=vierrataleai.cli:main",
            "vierratale=vierrataleai.cli:main",
        ],
    },
    package_data={
        "vierrataleai": ["prompts/*.json", "prompts/*.md"],
    },
    author="Vierratale",
    license="MIT",
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Libraries",
    ],
)
